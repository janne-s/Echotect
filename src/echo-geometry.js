const metresPerDegreeLatitude = 110540;

function coordinateSpace(origin) {
  const metresPerDegreeLongitude = 111320 * Math.cos(origin.latitude * Math.PI / 180);
  return {
    toXY: coordinate => ({
      x: (coordinate[0] - origin.longitude) * metresPerDegreeLongitude,
      y: (coordinate[1] - origin.latitude) * metresPerDegreeLatitude
    }),
    fromXY: point => ({
      longitude: origin.longitude + point.x / metresPerDegreeLongitude,
      latitude: origin.latitude + point.y / metresPerDegreeLatitude
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

function cross(a, b) {
  return a.x * b.y - a.y * b.x;
}

function wallSide(a, wall, point) {
  return cross(wall, { x: point.x - a.x, y: point.y - a.y });
}

function segmentIntersection(firstStart, firstEnd, secondStart, secondEnd) {
  const first = { x: firstEnd.x - firstStart.x, y: firstEnd.y - firstStart.y };
  const second = { x: secondEnd.x - secondStart.x, y: secondEnd.y - secondStart.y };
  const denominator = cross(first, second);
  if (Math.abs(denominator) < 1e-8) return null;
  const delta = { x: secondStart.x - firstStart.x, y: secondStart.y - firstStart.y };
  return { first: cross(delta, second) / denominator, second: cross(delta, first) / denominator };
}

function clearPath(from, to, obstacles, targetKey, space) {
  const start = space.toXY([from.longitude, from.latitude]);
  const end = space.toXY([to.longitude, to.latitude]);
  return !obstacles.some(obstacle => {
    if (obstacle.key === targetKey) return false;
    const intersection = segmentIntersection(start, end, space.toXY(obstacle.edge[0]), space.toXY(obstacle.edge[1]));
    return intersection && intersection.first > 1e-5 && intersection.first < 1 - 1e-5
      && intersection.second > 1e-5 && intersection.second < 1 - 1e-5;
  });
}

function exactReflectionPoint(a, b, source, listener, space) {
  const wall = { x: b.x - a.x, y: b.y - a.y };
  const lengthSquared = wall.x ** 2 + wall.y ** 2;
  if (lengthSquared < .01) return null;
  const projectionScale = ((source.x - a.x) * wall.x + (source.y - a.y) * wall.y) / lengthSquared;
  const projection = { x: a.x + projectionScale * wall.x, y: a.y + projectionScale * wall.y };
  const mirrored = { x: 2 * projection.x - source.x, y: 2 * projection.y - source.y };
  const intersection = segmentIntersection(mirrored, listener, a, b);
  if (!intersection || intersection.first < 0 || intersection.first > 1 || intersection.second < 0 || intersection.second > 1) return null;
  return space.fromXY({ x: a.x + intersection.second * wall.x, y: a.y + intersection.second * wall.y });
}

function diffuseReflectionPoint(a, b, source, listener, space) {
  const wall = { x: b.x - a.x, y: b.y - a.y };
  const lengthSquared = wall.x ** 2 + wall.y ** 2;
  if (lengthSquared < .01) return null;
  const midpoint = { x: (source.x + listener.x) / 2, y: (source.y + listener.y) / 2 };
  const scale = Math.max(0, Math.min(1, ((midpoint.x - a.x) * wall.x + (midpoint.y - a.y) * wall.y) / lengthSquared));
  return space.fromXY({ x: a.x + scale * wall.x, y: a.y + scale * wall.y });
}

export function wallReflectionCandidate({ edge, ring, source, listener, obstacles, radiusMetres, distanceMetres }) {
  const space = coordinateSpace(listener);
  const a = space.toXY(edge[0]);
  const b = space.toXY(edge[1]);
  const sourceXY = space.toXY([source.longitude, source.latitude]);
  const listenerXY = { x: 0, y: 0 };
  const wall = { x: b.x - a.x, y: b.y - a.y };
  const interiorSide = Math.sign(ringArea(ring)) || 1;
  if (wallSide(a, wall, sourceXY) * interiorSide > .01 || wallSide(a, wall, listenerXY) * interiorSide > .01) return null;

  const key = edgeKey(edge);
  const visible = point => point && distanceMetres(listener, point) <= radiusMetres
    && clearPath(source, point, obstacles, key, space)
    && clearPath(listener, point, obstacles, key, space);
  const specular = exactReflectionPoint(a, b, sourceXY, listenerXY, space);
  if (visible(specular)) return { point: specular, kind: 'specular' };
  const diffuse = diffuseReflectionPoint(a, b, sourceXY, listenerXY, space);
  return visible(diffuse) ? { point: diffuse, kind: 'diffuse' } : null;
}
