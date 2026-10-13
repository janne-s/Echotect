export const SPEED_OF_SOUND_METRES_PER_SECOND = 343;
export const EARTH_RADIUS_METRES = 6371008.8;
export const DISTANCE_METHOD = 'haversine';

/** Two points closer than this are treated as one place, not as a short path. */
export const COINCIDENT_DISTANCE_METRES = 0.01;

const METRES_PER_DEGREE_LATITUDE = 110540;
const METRES_PER_DEGREE_LONGITUDE_AT_EQUATOR = 111320;

export const toRadians = degrees => degrees * Math.PI / 180;

/** Approximation for humid air near atmospheric pressure; custom atmosphere affects timing. */
export function soundSpeedMetresPerSecond(settings = {}) {
  if (settings.airMode === 'off') return SPEED_OF_SOUND_METRES_PER_SECOND;
  const temperatureCelsius = settings.airMode === 'custom' ? settings.airTemperatureCelsius ?? 20 : 20;
  const relativeHumidityPercent = settings.airMode === 'custom' ? settings.airHumidityPercent ?? 50 : 50;
  return 331.3 + .606 * temperatureCelsius + .0124 * relativeHumidityPercent;
}

export const propagationSeconds = (pathMetres, speedOfSound = SPEED_OF_SOUND_METRES_PER_SECOND) => pathMetres / speedOfSound;

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

/**
 * In the map space, Source and Listener may stand at heights above the ground (`heightMetres`), and
 * every reflector is a vertical surface. Mirrored in vertical surfaces a path keeps its heights, so
 * it unfolds into a straight line: its length is √(horizontal² + height difference²), and it meets
 * each reflector at a height that runs evenly from the Source's to the Listener's along the
 * horizontal path. A reflector with a known `heightMetres` that the path meets above is passed over.
 * The terrain space measures its own three-dimensional distances and is not lifted here.
 */
const isLifted = (source, listener, distance) => distance === distanceMetres
  && Number.isFinite(source?.heightMetres) && Number.isFinite(listener?.heightMetres);

function liftedPath(legs, source, listener, reflectors) {
  const horizontalMetres = legs.reduce((sum, leg) => sum + leg, 0);
  const rise = listener.heightMetres - source.heightMetres;
  let travelled = 0;
  const blocked = reflectors.some((reflector, index) => {
    travelled += legs[index];
    const height = source.heightMetres + (horizontalMetres > 0 ? rise * travelled / horizontalMetres : 0);
    return Number.isFinite(reflector.heightMetres) && height > reflector.heightMetres;
  });
  return { pathMetres: Math.hypot(horizontalMetres, rise), blocked };
}

/** The elevation, degrees above the horizon, at which a lifted map path reaches the Listener; 0 when not lifted. */
export function liftedElevationDegrees(source, listener, horizontalMetres) {
  if (!Number.isFinite(source?.heightMetres) || !Number.isFinite(listener?.heightMetres)) return 0;
  return Math.atan2(source.heightMetres - listener.heightMetres, horizontalMetres) * 180 / Math.PI;
}

export function directSoundMetrics(source, listener, speedOfSound = SPEED_OF_SOUND_METRES_PER_SECOND, distance = distanceMetres) {
  const horizontalMetres = distance(source, listener);
  const pathMetres = isLifted(source, listener, distance) ? liftedPath([horizontalMetres], source, listener, []).pathMetres : horizontalMetres;
  return { pathMetres, horizontalMetres, propagationSeconds: propagationSeconds(pathMetres, speedOfSound) };
}

export const isDistinctPath = pathMetres => pathMetres > COINCIDENT_DISTANCE_METRES;

export function hasDistinctDirectArrival(source, listener) {
  return isDistinctPath(distanceMetres(source, listener));
}

export function reflectionMetrics(source, listener, reflector, speedOfSound = SPEED_OF_SOUND_METRES_PER_SECOND, distance = distanceMetres) {
  const listenerLegMetres = distance(listener, reflector);
  const { pathMetres, blocked, propagationSeconds: seconds } = reflectionPathMetrics(source, listener, [reflector], speedOfSound, distance);
  return { listenerLegMetres, pathMetres, blocked, propagationSeconds: seconds };
}

/** A path from the Source through reflectors to the Listener; `blocked` when it passes over a reflector. */
export function reflectionPathMetrics(source, listener, reflectors, speedOfSound = SPEED_OF_SOUND_METRES_PER_SECOND, distance = distanceMetres) {
  const legs = [];
  let previous = source;
  reflectors.forEach(reflector => {
    legs.push(distance(previous, reflector));
    previous = reflector;
  });
  legs.push(distance(previous, listener));
  const horizontalMetres = legs.reduce((sum, leg) => sum + leg, 0);
  const { pathMetres, blocked } = isLifted(source, listener, distance)
    ? liftedPath(legs, source, listener, reflectors)
    : { pathMetres: horizontalMetres, blocked: false };
  return { pathMetres, horizontalMetres, blocked, propagationSeconds: propagationSeconds(pathMetres, speedOfSound) };
}
