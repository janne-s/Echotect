const EARTH_RADIUS_METRES = 6371008.8;
const radians = degrees => degrees * Math.PI / 180;

export function relativePositionMetres(listener, emitter) {
  const meanLatitude = radians((listener.latitude + emitter.latitude) / 2);
  const east = radians(emitter.longitude - listener.longitude) * EARTH_RADIUS_METRES * Math.cos(meanLatitude);
  const north = radians(emitter.latitude - listener.latitude) * EARTH_RADIUS_METRES;
  return { east, north };
}

export function arrivalAzimuthDegrees(listener, emitter) {
  const { east, north } = relativePositionMetres(listener, emitter);
  return (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
}

export function hrtfPosition(listener, emitter, listenerHeadingDegrees = 0) {
  const { east, north } = relativePositionMetres(listener, emitter);
  if (Math.hypot(east, north) < 0.01) return null;
  const absoluteAzimuth = arrivalAzimuthDegrees(listener, emitter);
  const relativeAzimuth = radians(absoluteAzimuth - listenerHeadingDegrees);
  return { x: Math.sin(relativeAzimuth), y: 0, z: -Math.cos(relativeAzimuth) };
}
