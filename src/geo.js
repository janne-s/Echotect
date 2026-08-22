export const SPEED_OF_SOUND_METRES_PER_SECOND = 343;

const isCoordinate = (latitude, longitude) =>
  Number.isFinite(latitude) && Number.isFinite(longitude) &&
  Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;

export function parseCoordinates(value) {
  const text = value.trim();
  if (!text) return null;

  let decoded = text;
  try { decoded = decodeURIComponent(text); } catch { /* Keep original text. */ }

  const patterns = [
    /@(-?\d{1,3}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)/,
    /(?:[?&](?:q|query|ll|center|sll)=)(-?\d{1,3}(?:\.\d+)?)(?:,|%20|\s)+(-?\d{1,3}(?:\.\d+)?)/i,
    /(?<![\d.])(-?\d{1,3}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)(?![\d.])/,
    /^\s*(-?\d{1,3}(?:\.\d+)?)\s+(-?\d{1,3}(?:\.\d+)?)\s*$/
  ];

  for (const pattern of patterns) {
    const match = decoded.match(pattern);
    if (!match) continue;
    const latitude = Number(match[1]);
    const longitude = Number(match[2]);
    if (isCoordinate(latitude, longitude)) return { latitude, longitude };
  }
  return null;
}

const radians = degrees => degrees * Math.PI / 180;

export function distanceMetres(a, b) {
  const earthRadiusMetres = 6371008.8;
  const latitudeDelta = radians(b.latitude - a.latitude);
  const longitudeDelta = radians(b.longitude - a.longitude);
  const latitudeA = radians(a.latitude);
  const latitudeB = radians(b.latitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusMetres * Math.asin(Math.sqrt(haversine));
}

export function reflectionMetrics(source, listener, reflector) {
  const sourceLegMetres = distanceMetres(source, reflector);
  const listenerLegMetres = distanceMetres(listener, reflector);
  const pathMetres = sourceLegMetres + listenerLegMetres;
  return {
    listenerLegMetres,
    pathMetres,
    propagationSeconds: pathMetres / SPEED_OF_SOUND_METRES_PER_SECOND
  };
}
