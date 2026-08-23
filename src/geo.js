export const SPEED_OF_SOUND_METRES_PER_SECOND = 343;
export const EARTH_RADIUS_METRES = 6371008.8;
export const DISTANCE_METHOD = 'haversine';

/** Two points closer than this are treated as one place, not as a short path. */
export const COINCIDENT_DISTANCE_METRES = 0.01;

const METRES_PER_DEGREE_LATITUDE = 110540;
const METRES_PER_DEGREE_LONGITUDE_AT_EQUATOR = 111320;

export const toRadians = degrees => degrees * Math.PI / 180;

export const propagationSeconds = pathMetres => pathMetres / SPEED_OF_SOUND_METRES_PER_SECOND;

export const isValidCoordinate = point =>
  Number.isFinite(point?.latitude) && Math.abs(point.latitude) <= 90 &&
  Number.isFinite(point?.longitude) && Math.abs(point.longitude) <= 180;

/** Local flat-earth scale factors, accurate enough for the metre-scale offsets used on screen. */
export const metresPerDegreeLatitude = () => METRES_PER_DEGREE_LATITUDE;
export const metresPerDegreeLongitude = latitudeDegrees =>
  METRES_PER_DEGREE_LONGITUDE_AT_EQUATOR * Math.cos(toRadians(latitudeDegrees));

/** Degrees with either decimal separator, so a pasted Finnish coordinate reads the same as a dotted one. */
const DEGREES = String.raw`\d{1,3}(?:[.,]\d+)?`;
/** A degree value tagged with its hemisphere, written before or after the number. */
const HEMISPHERE_DEGREES = new RegExp(`(${DEGREES})\\s*°?\\s*([NSEW])|([NSEW])\\s*(${DEGREES})\\s*°?`, 'gi');

const degreeNumber = text => Number(text.replace(',', '.'));

/** Reads `61,80228° N, 21,52714° E` and its variants, in either axis order. */
function hemisphereCoordinates(text) {
  let latitude = null;
  let longitude = null;
  for (const match of text.matchAll(HEMISPHERE_DEGREES)) {
    const value = degreeNumber(match[1] ?? match[4]);
    const hemisphere = (match[2] ?? match[3]).toUpperCase();
    const signed = hemisphere === 'S' || hemisphere === 'W' ? -value : value;
    if (hemisphere === 'N' || hemisphere === 'S') latitude ??= signed;
    else longitude ??= signed;
  }
  return latitude === null || longitude === null ? null : { latitude, longitude };
}

const COORDINATE_PATTERNS = [
  /@(-?\d{1,3}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)/,
  /(?:[?&](?:q|query|ll|center|sll)=)(-?\d{1,3}(?:\.\d+)?)(?:,|%20|\s)+(-?\d{1,3}(?:\.\d+)?)/i,
  /(?<![\d.])(-?\d{1,3}(?:\.\d+)?)\s*°?\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)\s*°?(?![\d.])/,
  // Separated by a space or a semicolon, a decimal comma cannot be mistaken for the pair separator.
  /^\s*(-?\d{1,3}(?:[.,]\d+)?)\s*°?\s+(-?\d{1,3}(?:[.,]\d+)?)\s*°?\s*$/,
  /^\s*(-?\d{1,3},\d+)\s*°?\s*;\s*(-?\d{1,3},\d+)\s*°?\s*$/
];

export function parseCoordinates(value) {
  const text = value.trim();
  if (!text) return null;

  let decoded = text;
  try { decoded = decodeURIComponent(text); } catch { /* Keep original text. */ }

  const tagged = hemisphereCoordinates(decoded);
  if (tagged && isValidCoordinate(tagged)) return tagged;

  for (const pattern of COORDINATE_PATTERNS) {
    const match = decoded.match(pattern);
    if (!match) continue;
    const point = { latitude: degreeNumber(match[1]), longitude: degreeNumber(match[2]) };
    if (isValidCoordinate(point)) return point;
  }
  return null;
}

export function distanceMetres(a, b) {
  const latitudeDelta = toRadians(b.latitude - a.latitude);
  const longitudeDelta = toRadians(b.longitude - a.longitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.sqrt(haversine));
}

export function directSoundMetrics(source, listener) {
  const pathMetres = distanceMetres(source, listener);
  return { pathMetres, propagationSeconds: propagationSeconds(pathMetres) };
}

export const isDistinctPath = pathMetres => pathMetres > COINCIDENT_DISTANCE_METRES;

export function hasDistinctDirectArrival(source, listener) {
  return isDistinctPath(distanceMetres(source, listener));
}

export function reflectionMetrics(source, listener, reflector) {
  const listenerLegMetres = distanceMetres(listener, reflector);
  const pathMetres = distanceMetres(source, reflector) + listenerLegMetres;
  return { listenerLegMetres, pathMetres, propagationSeconds: propagationSeconds(pathMetres) };
}

export function reflectionPathMetrics(source, listener, reflectors) {
  let pathMetres = 0;
  let previous = source;
  reflectors.forEach(reflector => {
    pathMetres += distanceMetres(previous, reflector);
    previous = reflector;
  });
  pathMetres += distanceMetres(previous, listener);
  return { pathMetres, propagationSeconds: propagationSeconds(pathMetres) };
}
