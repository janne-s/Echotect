import test from 'node:test';
import assert from 'node:assert/strict';
import { createEarlyArrivalEvents } from '../src/arrivals.js';
import { normalizeEchoFieldSettings } from '../src/echo-field-settings.js';
import { distanceMetres } from '../src/geo.js';
import { buildTerrainField, floorOutline, normalizeTerrainSpace, parseTerrainSpace, placePoint, sectionProfile, serializeTerrainSpace, tallestCavityPoint, terrainDistanceMetres, terrainFacets, terrainFrame, terrainHeightMetres } from '../src/terrain-space.js';
import { at, distance3d, reflectionPathMetres, syntheticSpace, terrainHeights } from './support/terrain.js';

const SPEED_OF_SOUND = 343;
const ONE_SAMPLE_METRES = SPEED_OF_SOUND / 48000;

const field = (space, source, listener, maxSurfaces = 100000) => buildTerrainField({
  space, source, listener, globalReflectionLevelDb: -6, maxSurfaces, speedOfSound: SPEED_OF_SOUND
});
const specular = result => result.reflectors.filter(reflector => reflector.reflectionKind === 'terrain-specular');
const flat = overrides => syntheticSpace(() => 100, undefined, { scattering: .5, ...terrainHeights(2), ...overrides });

test('a flat exterior plane gives its ground reflection at the image-source time', () => {
  const result = field(flat(), at(-50, 0), at(50, 0));
  const reflections = specular(result);
  assert.equal(reflections.length, 1);
  assert.ok(Math.abs(reflectionPathMetres(result, reflections[0]) - Math.hypot(100, 4)) < ONE_SAMPLE_METRES);
  assert.equal(result.directOccluded, false);
});

test('a steep face reflects at the mirror point of its plane', () => {
  const space = syntheticSpace((x) => x > 100 ? (x - 100) * 5 : 0, undefined, { scattering: 0, ...terrainHeights(150) });
  const result = field(space, at(0, -20), at(0, 20));
  const normal = { x: 5 / Math.sqrt(26), y: 0, z: -1 / Math.sqrt(26) };
  const S = result.source.positionMetres;
  const planeDistance = normal.x * (S.x - 100) + normal.z * S.z;
  const mirrored = { x: S.x - 2 * planeDistance * normal.x, y: S.y, z: S.z - 2 * planeDistance * normal.z };
  const expected = distance3d(mirrored, result.listener.positionMetres);
  const face = specular(result).filter(reflector => reflector.positionMetres.x > 110);
  assert.equal(face.length, 1);
  assert.ok(Math.abs(reflectionPathMetres(result, face[0]) - expected) < ONE_SAMPLE_METRES);
  assert.ok(Math.abs(face[0].positionMetres.x - 125) < .01);
});

test('a symmetric V-canyon returns equal delays from both walls', () => {
  const space = syntheticSpace(x => .8 * Math.abs(x), undefined, { scattering: 0, ...terrainHeights(30) });
  const point = at(0, 0);
  const result = field(space, point, point);
  const walls = specular(result).filter(reflector => Math.abs(reflector.positionMetres.x) > 5);
  assert.equal(walls.length, 2);
  const [first, second] = walls.map(reflector => reflectionPathMetres(result, reflector));
  assert.ok(Math.abs(first - second) < 1e-6);
  const lowestSample = .8 * 5;
  const heightAboveValleyAxis = result.listener.positionMetres.z + lowestSample;
  assert.ok(Math.abs(first - 2 * heightAboveValleyAxis / Math.sqrt(1.64)) < ONE_SAMPLE_METRES);
  const azimuths = walls.map(reflector => Math.round((Math.atan2(reflector.positionMetres.x, reflector.positionMetres.y) * 180 / Math.PI + 360) % 360)).sort((a, b) => a - b);
  assert.deepEqual(azimuths, [90, 270]);
});

const box = overrides => syntheticSpace((x, y) => Math.max(Math.abs(x), Math.abs(y)) < 250 ? 100 : 0, undefined, {
  mode: 'interior', floorElevationMetres: 10, scattering: 0, ...terrainHeights(30, 30, 'interior'), ...overrides
});

test('an interior box gives floor, ceiling, and floor-to-ceiling flutter at their image-source times', () => {
  const point = at(0, 0);
  const result = field(box(), point, point);
  assert.equal(result.valid, true);
  const settings = normalizeEchoFieldSettings({ pointMaxBounces: 3, buildingOcclusion: true, airMode: 'off' });
  const paths = createEarlyArrivalEvents({ source: result.source, listener: result.listener, reflectors: result.reflectors, settings, distanceMetres: terrainDistanceMetres })
    .map(event => event.pathMetres);
  for (const expected of [2 * 30, 2 * 60, 2 * 90]) {
    assert.ok(paths.some(pathMetres => Math.abs(pathMetres - expected) < ONE_SAMPLE_METRES), `missing ${expected} m`);
  }
});

const pyramid = overrides => syntheticSpace((x, y) => 200 - .5 * Math.max(Math.abs(x), Math.abs(y)), undefined, {
  mode: 'interior', floorElevationMetres: 60, scattering: 0, ...terrainHeights(10, 10, 'interior'), ...overrides
});

test('a tapering cavity brings its ceiling closer as the Listener rises', () => {
  const point = at(0, 0);
  const nearestCeiling = height => {
    const result = field(pyramid(terrainHeights(height, height, 'interior')), point, point);
    return Math.min(...specular(result).filter(reflector => reflector.terrainSurface === 'ceiling').map(reflector => reflectionPathMetres(result, reflector)));
  };
  const low = nearestCeiling(10);
  const high = nearestCeiling(60);
  assert.ok(high < low);
  assert.ok(Math.abs(low - 2 * (140 - 10) / Math.sqrt(1.25)) < ONE_SAMPLE_METRES);
});

test('raising the floor narrows the cavity', () => {
  const extent = space => {
    const facets = terrainFacets(terrainFrame(space));
    return { count: facets.length, reach: Math.max(...facets.map(facet => Math.abs(facet.position.x))) };
  };
  const low = extent(pyramid({ floorElevationMetres: 60 }));
  const high = extent(pyramid({ floorElevationMetres: 120 }));
  assert.ok(high.count < low.count);
  assert.ok(high.reach < low.reach);
  assert.ok(floorOutline(terrainFrame(pyramid())).length > 0);
});

test('a ridge between Source and Listener occludes the direct path', () => {
  const ridge = syntheticSpace(x => Math.abs(x) < 20 ? 150 : 0, undefined, terrainHeights(2));
  assert.equal(field(ridge, at(-100, 0), at(100, 0)).directOccluded, true);
  assert.equal(field(flat(), at(-100, 0), at(100, 0)).directOccluded, false);
});

test('a Listener outside the cavity is rejected and nothing is built', () => {
  const result = field(box(), at(0, 0), at(290, 0));
  assert.equal(result.valid, false);
  assert.equal(result.listener.reason, 'outside-cavity');
  assert.deepEqual(result.reflectors, []);
  assert.equal(field(flat(), at(0, 0), at(400, 0)).listener.reason, 'outside');
});

test('interior heights clamp to the ceiling above the point', () => {
  const frame = terrainFrame(box());
  const placed = placePoint(frame, at(0, 0), 200);
  assert.equal(placed.heightMetres, 89.5);
  const pyramidFrame = terrainFrame(pyramid());
  assert.equal(placePoint(pyramidFrame, at(0, 0), 80).heightMetres, 80);
  assert.ok(Math.abs(placePoint(pyramidFrame, at(200, 0), 80).heightMetres - 39.5) < 1e-3);
});

test('ground reflection level moves only the ground under the points', () => {
  const groundLevel = groundReflectionDb => {
    const result = field(flat({ groundReflectionDb, scattering: .5 }), at(-15, 0), at(15, 0));
    return {
      specular: specular(result).find(reflector => reflector.ground)?.levelDb ?? null,
      distant: result.reflectors.filter(reflector => !reflector.ground).map(reflector => [reflector.id, reflector.levelDb])
    };
  };
  const physical = groundLevel(0);
  const raised = groundLevel(6);
  const off = groundLevel(null);
  assert.ok(Math.abs(raised.specular - physical.specular - 6) < 1e-9);
  assert.equal(off.specular, null);
  assert.deepEqual(raised.distant, physical.distant);
  assert.deepEqual(off.distant, physical.distant);
});

test('the acoustic scale transforms the fixed field without moving it on the map', () => {
  const canyon = (x, y) => 40 * Math.sin(x / 60) + 25 * Math.cos(y / 45) + .5 * Math.abs(x);
  const measure = scale => {
    const space = syntheticSpace(canyon, undefined, { scattering: .5, scale, ...terrainHeights(20) });
    const result = field(space, at(-60, 30), at(80, -40));
    return {
      source: result.source,
      listener: result.listener,
      reflectors: result.reflectors.map(reflector => ({
        id: reflector.id,
        latitude: reflector.latitude,
        longitude: reflector.longitude,
        positionMetres: reflector.positionMetres,
        metres: reflectionPathMetres(result, reflector),
        levelDb: reflector.levelDb
      }))
      .sort((a, b) => a.id < b.id ? -1 : 1)
    };
  };
  const base = measure(1);
  const doubled = measure(2);
  assert.ok(base.reflectors.length > 0);
  assert.deepEqual(doubled.reflectors.map(item => item.id), base.reflectors.map(item => item.id));
  assert.deepEqual(
    doubled.reflectors.map(item => [item.latitude, item.longitude, item.levelDb]),
    base.reflectors.map(item => [item.latitude, item.longitude, item.levelDb])
  );
  ['source', 'listener'].forEach(role => {
    assert.equal(doubled[role].heightMetres, 2 * base[role].heightMetres);
    assert.equal(doubled[role].heightSettingMetres, base[role].heightSettingMetres);
    Object.keys(base[role].positionMetres).forEach(axis => assert.ok(Math.abs(doubled[role].positionMetres[axis] - 2 * base[role].positionMetres[axis]) < 1e-6));
  });
  doubled.reflectors.forEach((item, index) => {
    Object.keys(item.positionMetres).forEach(axis => assert.ok(Math.abs(item.positionMetres[axis] - 2 * base.reflectors[index].positionMetres[axis]) < 1e-6));
    assert.ok(Math.abs(item.metres - 2 * base.reflectors[index].metres) < 1e-6);
  });
});

test('identical terrain and placement build an identical field', () => {
  const space = syntheticSpace((x, y) => 30 * Math.sin(x / 40) * Math.cos(y / 70), undefined, { scattering: .5 });
  assert.deepEqual(field(space, at(-30, 20), at(60, -10)), field(space, at(-30, 20), at(60, -10)));
});

test('a stored terrain space round-trips its heightfield exactly', () => {
  const space = syntheticSpace((x, y) => 1234.5678 + x * .0137 - y * .731, { columns: 33, rows: 17, widthMetres: 330, heightMetres: 170 }, { mode: 'interior', scale: .05, groundReflectionDb: null });
  const opened = parseTerrainSpace(JSON.parse(JSON.stringify(serializeTerrainSpace(space))));
  assert.deepEqual(opened.capture.values, space.capture.values);
  assert.equal(opened.mode, 'interior');
  assert.equal(opened.scale, .05);
  assert.equal(opened.groundReflectionDb, null);
  assert.deepEqual(opened.capture.bounds, space.capture.bounds);
});

test('Canyon and Chamber restore and persist their own Source and Listener heights', () => {
  const canyon = normalizeTerrainSpace({
    ...syntheticSpace(() => 100),
    heightsMetres: {
      exterior: { source: 18, listener: 7 },
      interior: { source: 4, listener: 2 }
    }
  });
  const chamber = normalizeTerrainSpace({
    ...canyon,
    mode: 'interior',
    heightsMetres: { ...canyon.heightsMetres, interior: { source: 12, listener: 9 } }
  });
  assert.equal(terrainHeightMetres(chamber, 'source'), 12);
  assert.equal(terrainHeightMetres(chamber, 'listener'), 9);

  const restoredCanyon = normalizeTerrainSpace({ ...chamber, mode: 'exterior' });
  assert.equal(terrainHeightMetres(restoredCanyon, 'source'), 18);
  assert.equal(terrainHeightMetres(restoredCanyon, 'listener'), 7);

  const reopened = parseTerrainSpace(JSON.parse(JSON.stringify(serializeTerrainSpace(restoredCanyon))));
  assert.deepEqual(reopened.heightsMetres, restoredCanyon.heightsMetres);
});

test('stored values are clamped against the controls they drive', () => {
  const space = syntheticSpace(() => 0);
  const normalized = normalizeTerrainSpace({ ...space, scale: 1000, groundReflectionDb: 99, scattering: -1, material: 'lava', mode: 'orbit' });
  assert.equal(normalized.scale, 10);
  assert.equal(normalized.groundReflectionDb, 6);
  assert.equal(normalized.scattering, 0);
  assert.equal(normalized.material, 'stone');
  assert.equal(normalized.mode, 'exterior');
  assert.equal(normalizeTerrainSpace({ ...space, capture: { ...space.capture, values: new Float32Array(3) } }), null);
});

test('terrain distances agree with the project haversine distance on level ground', () => {
  const level = syntheticSpace(() => 0, { columns: 64, rows: 64, widthMetres: 24000, heightMetres: 24000 }, terrainHeights(2));
  const frame = terrainFrame(level);
  const source = placePoint(frame, at(-7000, -3000), 2);
  const listener = placePoint(frame, at(7000, 3000), 2);
  assert.ok(Math.abs(terrainDistanceMetres(source, listener) - distanceMetres(source, listener)) < ONE_SAMPLE_METRES);
});

test('the acoustic scale leaves reflection points where the terrain is on the map', () => {
  const canyon = (x, y) => 40 * Math.sin(x / 60) + 25 * Math.cos(y / 45) + .5 * Math.abs(x);
  const positions = scale => field(syntheticSpace(canyon, undefined, { scattering: 0, scale, ...terrainHeights(20) }), at(-60, 30), at(80, -40))
    .reflectors.map(reflector => [reflector.latitude, reflector.longitude]);
  const base = positions(1);
  positions(3).forEach(([latitude, longitude], index) => {
    assert.ok(Math.abs(latitude - base[index][0]) < 1e-9);
    assert.ok(Math.abs(longitude - base[index][1]) < 1e-9);
  });
});

test('the section runs through Source and Listener across the whole rectangle', () => {
  const frame = terrainFrame(syntheticSpace(x => x > 100 ? (x - 100) * 5 : 0, undefined, { scale: 2 }));
  const section = sectionProfile(frame, at(-100, 0), at(100, 0), 64);
  assert.ok(Math.abs(section.lengthMetres - 640 * 2) < 1e-6);
  assert.ok(Math.abs(section.sourceDistanceMetres - 220 * 2) < 1e-6);
  assert.ok(Math.abs(section.listenerDistanceMetres - 420 * 2) < 1e-6);
  assert.equal(section.points.length, 64);
  assert.ok(section.points.at(-1).surfaceMetres > section.points[0].surfaceMetres);
  assert.ok(sectionProfile(frame, at(0, 0), at(0, 0), 8).lengthMetres > 0);
});

test('the tallest cavity point lies under the highest ceiling', () => {
  const frame = terrainFrame(syntheticSpace((x, y) => 200 - .5 * Math.max(Math.abs(x - 100), Math.abs(y)), undefined, { mode: 'interior', floorElevationMetres: 60 }));
  const { point } = tallestCavityPoint(frame);
  const placed = placePoint(frame, point, 10);
  assert.equal(placed.valid, true);
  assert.ok(Math.abs(frame.worldFromPoint(point).x - 100) < 10);
});
