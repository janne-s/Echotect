import { metresPerDegreeLatitude, metresPerDegreeLongitude } from './geo.js';

/** Intersections below this determinant are parallel; endpoints this close count as touching. */
const PARALLEL_EPSILON = 1e-8;
const ENDPOINT_EPSILON = 1e-5;
/** Square metres. Shorter walls cannot carry a stable reflection point. */
const MINIMUM_WALL_LENGTH_SQUARED = .01;
/** Tolerance in square metres for deciding which side of a wall a point is on. */
const WALL_SIDE_EPSILON = .01;
/**
 * Walls are pre-selected in the flat metre grid while the accepted radius is measured with the
 * project distance method, so the pre-selection keeps a margin and never rejects a valid wall.
 */
const RADIUS_PREFILTER_MARGIN = 1.05;

const LISTENER_ORIGIN = Object.freeze({ x: 0, y: 0 });

/** Local metre grid centred on the origin, used for the flat wall geometry around the Listener. */
function coordinateSpace(origin) {
  const eastScale = metresPerDegreeLongitude(origin.latitude);
  const northScale = metresPerDegreeLatitude();
  return {
    toXY: coordinate => ({
      x: (coordinate[0] - origin.longitude) * eastScale,
      y: (coordinate[1] - origin.latitude) * northScale
    }),
    fromXY: point => ({
      longitude: origin.longitude + point.x / eastScale,
      latitude: origin.latitude + point.y / northScale
    })
  };
}

export function edgeKey(edge) {
  return edge.map(point => point.slice(0, 2).map(value => value.toFixed(5)).join(',')).sort().join('|');
}

function ringArea(ring) {
  return ring.slice(1).reduce((area, point, index) =>
    area + ring[index][0] * point[1] - point[0] * ring[index][1], 0) / 2;
}

const cross = (ax, ay, bx, by) => ax * by - ay * bx;
const clamp01 = value => Math.max(0, Math.min(1, value));

/** Writes the two segment parameters into `out` and reports whether the segments are not parallel. */
function intersectionParameters(firstStart, firstEnd, secondStart, secondEnd, out) {
  const firstX = firstEnd.x - firstStart.x;
  const firstY = firstEnd.y - firstStart.y;
  const secondX = secondEnd.x - secondStart.x;
  const secondY = secondEnd.y - secondStart.y;
  const denominator = cross(firstX, firstY, secondX, secondY);
  if (Math.abs(denominator) < PARALLEL_EPSILON) return false;
  const deltaX = secondStart.x - firstStart.x;
  const deltaY = secondStart.y - firstStart.y;
  out.first = cross(deltaX, deltaY, secondX, secondY) / denominator;
  out.second = cross(deltaX, deltaY, firstX, firstY) / denominator;
  return true;
}

function squaredDistanceFromListener(a, b) {
  const spanX = b.x - a.x;
  const spanY = b.y - a.y;
  const lengthSquared = spanX ** 2 + spanY ** 2;
  const scale = lengthSquared ? clamp01(-(a.x * spanX + a.y * spanY) / lengthSquared) : 0;
  return (a.x + scale * spanX) ** 2 + (a.y + scale * spanY) ** 2;
}

function clearPath(start, end, obstacles, targetKey, parameters) {
  for (const obstacle of obstacles) {
    if (obstacle.key === targetKey) continue;
    if (!intersectionParameters(start, end, obstacle.a, obstacle.b, parameters)) continue;
    if (parameters.first > ENDPOINT_EPSILON && parameters.first < 1 - ENDPOINT_EPSILON
      && parameters.second > ENDPOINT_EPSILON && parameters.second < 1 - ENDPOINT_EPSILON) return false;
  }
  return true;
}

/**
 * Prepares one rebuild: a single metre grid centred on the Listener, the Source in that grid, and
 * every wall that could block a Source → point → Listener path projected once. Walls outside the
 * box that holds those paths cannot block one and are dropped here instead of in every wall test.
 */
export function reflectionField({ source, listener, walls, radiusMetres }) {
  const space = coordinateSpace(listener);
  const sourceXY = space.toXY([source.longitude, source.latitude]);
  const minimumX = Math.min(sourceXY.x, -radiusMetres);
  const maximumX = Math.max(sourceXY.x, radiusMetres);
  const minimumY = Math.min(sourceXY.y, -radiusMetres);
  const maximumY = Math.max(sourceXY.y, radiusMetres);
  const obstacles = [];
  for (const wall of walls) {
    const a = space.toXY(wall.edge[0]);
    const b = space.toXY(wall.edge[1]);
    if (Math.max(a.x, b.x) < minimumX || Math.min(a.x, b.x) > maximumX) continue;
    if (Math.max(a.y, b.y) < minimumY || Math.min(a.y, b.y) > maximumY) continue;
    obstacles.push({
      key: wall.key,
      a,
      b,
      minimumX: Math.min(a.x, b.x),
      maximumX: Math.max(a.x, b.x),
      minimumY: Math.min(a.y, b.y),
      maximumY: Math.max(a.y, b.y)
    });
  }
  return { space, source, listener, sourceXY, obstacles, radiusMetres };
}

/**
 * Builds the reflector visibility graph once so recursive path searches do not ray cast at every
 * bounce. Endpoint walls are ignored: touching the wall that owns a reflection point is expected.
 */
export function reflectorVisibilityGraph(field, reflectors) {
  const projected = reflectors.map(reflector => ({
    reflector,
    point: field.space.toXY([reflector.longitude, reflector.latitude]),
    wallKey: reflector.buildingEdge ? edgeKey(reflector.buildingEdge) : null,
    visible: []
  }));
  const parameters = { first: 0, second: 0 };
  for (let first = 0; first < projected.length; first += 1) {
    for (let second = first + 1; second < projected.length; second += 1) {
      const a = projected[first];
      const b = projected[second];
      const minimumX = Math.min(a.point.x, b.point.x);
      const maximumX = Math.max(a.point.x, b.point.x);
      const minimumY = Math.min(a.point.y, b.point.y);
      const maximumY = Math.max(a.point.y, b.point.y);
      let visible = true;
      for (const obstacle of field.obstacles) {
        if (obstacle.key === a.wallKey || obstacle.key === b.wallKey) continue;
        if (obstacle.maximumX < minimumX || obstacle.minimumX > maximumX
          || obstacle.maximumY < minimumY || obstacle.minimumY > maximumY) continue;
        if (!intersectionParameters(a.point, b.point, obstacle.a, obstacle.b, parameters)) continue;
        if (parameters.first > ENDPOINT_EPSILON && parameters.first < 1 - ENDPOINT_EPSILON
          && parameters.second > ENDPOINT_EPSILON && parameters.second < 1 - ENDPOINT_EPSILON) {
          visible = false;
          break;
        }
      }
      if (!visible) continue;
      a.visible.push(b.reflector.id);
      b.visible.push(a.reflector.id);
    }
  }
  return new Map(projected.map(item => [item.reflector.id, item.visible]));
}

/**
 * The reflection point a wall contributes, or null. Prefers the exact mirror point and falls back
 * to a diffuse point on the same wall; both must stay inside the radius and be visible from the
 * Source and the Listener.
 */
export function wallReflectionCandidate(field, wall, distanceMetres) {
  const { space, sourceXY, obstacles, radiusMetres, listener } = field;
  const a = space.toXY(wall.edge[0]);
  const b = space.toXY(wall.edge[1]);
  if (squaredDistanceFromListener(a, b) > (radiusMetres * RADIUS_PREFILTER_MARGIN) ** 2) return null;

  const wallX = b.x - a.x;
  const wallY = b.y - a.y;
  const lengthSquared = wallX ** 2 + wallY ** 2;
  if (lengthSquared < MINIMUM_WALL_LENGTH_SQUARED) return null;

  const interiorSide = Math.sign(ringArea(wall.ring)) || 1;
  const sourceSide = cross(wallX, wallY, sourceXY.x - a.x, sourceXY.y - a.y);
  const listenerSide = cross(wallX, wallY, -a.x, -a.y);
  if (sourceSide * interiorSide > WALL_SIDE_EPSILON || listenerSide * interiorSide > WALL_SIDE_EPSILON) return null;

  const key = edgeKey(wall.edge);
  const parameters = { first: 0, second: 0 };
  const visible = pointXY => {
    if (!pointXY) return null;
    const point = space.fromXY(pointXY);
    if (distanceMetres(listener, point) > radiusMetres) return null;
    if (!clearPath(sourceXY, pointXY, obstacles, key, parameters)) return null;
    if (!clearPath(LISTENER_ORIGIN, pointXY, obstacles, key, parameters)) return null;
    return point;
  };

  const projectionScale = ((sourceXY.x - a.x) * wallX + (sourceXY.y - a.y) * wallY) / lengthSquared;
  const mirrored = {
    x: 2 * (a.x + projectionScale * wallX) - sourceXY.x,
    y: 2 * (a.y + projectionScale * wallY) - sourceXY.y
  };
  let specular = null;
  if (intersectionParameters(mirrored, LISTENER_ORIGIN, a, b, parameters)
    && parameters.first >= 0 && parameters.first <= 1 && parameters.second >= 0 && parameters.second <= 1) {
    specular = { x: a.x + parameters.second * wallX, y: a.y + parameters.second * wallY };
  }
  const specularPoint = visible(specular);
  if (specularPoint) return { point: specularPoint, kind: 'specular' };

  const midpointScale = clamp01(((sourceXY.x / 2 - a.x) * wallX + (sourceXY.y / 2 - a.y) * wallY) / lengthSquared);
  const diffusePoint = visible({ x: a.x + midpointScale * wallX, y: a.y + midpointScale * wallY });
  return diffusePoint ? { point: diffusePoint, kind: 'diffuse' } : null;
}
