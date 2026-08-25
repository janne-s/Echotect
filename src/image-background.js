import { metresPerDegreeLatitude, metresPerDegreeLongitude } from './geo.js';

export const IMAGE_WIDTH_RANGE = Object.freeze({ minimum: 1, maximum: 100000, fallback: 100 });
export const IMAGE_OPACITY_RANGE = Object.freeze({ minimum: .1, maximum: 1, fallback: .75 });

const radians = degrees => degrees * Math.PI / 180;

function rotateLocal(x, y, degrees) {
  const angle = radians(degrees);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return { x: x * cosine + y * sine, y: -x * sine + y * cosine };
}

function pointFromLocal(center, local) {
  return {
    latitude: center.latitude + local.y / metresPerDegreeLatitude(),
    longitude: center.longitude + local.x / metresPerDegreeLongitude(center.latitude)
  };
}

function pointToLocal(center, point) {
  return {
    x: (point.longitude - center.longitude) * metresPerDegreeLongitude(center.latitude),
    y: (point.latitude - center.latitude) * metresPerDegreeLatitude()
  };
}

export function imageCoordinates(background) {
  const halfWidth = background.widthMetres / 2;
  const halfHeight = halfWidth * background.pixelHeight / background.pixelWidth;
  return [
    [-halfWidth, halfHeight],
    [halfWidth, halfHeight],
    [halfWidth, -halfHeight],
    [-halfWidth, -halfHeight]
  ].map(([x, y]) => {
    const point = pointFromLocal(background.center, rotateLocal(x, y, background.rotationDegrees));
    return [point.longitude, point.latitude];
  });
}

/** Keeps placed geometry attached to the image when its scale or rotation changes. */
export function transformImagePoint(point, previous, next) {
  const local = pointToLocal(previous.center, point);
  const unrotated = rotateLocal(local.x, local.y, -previous.rotationDegrees);
  const scale = next.widthMetres / previous.widthMetres;
  return pointFromLocal(next.center, rotateLocal(unrotated.x * scale, unrotated.y * scale, next.rotationDegrees));
}

export function transformImageEdge(edge, previous, next) {
  return edge.map(([longitude, latitude]) => {
    const point = transformImagePoint({ longitude, latitude }, previous, next);
    return [point.longitude, point.latitude];
  });
}
