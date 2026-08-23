import { COINCIDENT_DISTANCE_METRES, EARTH_RADIUS_METRES, toRadians } from './geo.js';
import { clampToRange } from './range.js';

const PAN_RANGE = Object.freeze({ minimum: -1, maximum: 1 });

export function relativePositionMetres(listener, emitter) {
  const meanLatitude = toRadians((listener.latitude + emitter.latitude) / 2);
  const east = toRadians(emitter.longitude - listener.longitude) * EARTH_RADIUS_METRES * Math.cos(meanLatitude);
  const north = toRadians(emitter.latitude - listener.latitude) * EARTH_RADIUS_METRES;
  return { east, north };
}

export function arrivalAzimuthDegrees(listener, emitter) {
  const { east, north } = relativePositionMetres(listener, emitter);
  return (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
}

export function hrtfPosition(listener, emitter, listenerHeadingDegrees = 0) {
  const { east, north } = relativePositionMetres(listener, emitter);
  if (Math.hypot(east, north) < COINCIDENT_DISTANCE_METRES) return null;
  const absoluteAzimuth = arrivalAzimuthDegrees(listener, emitter);
  const relativeAzimuth = toRadians(absoluteAzimuth - listenerHeadingDegrees);
  return { x: Math.sin(relativeAzimuth), y: 0, z: -Math.cos(relativeAzimuth) };
}

/** Canonical stereo placement: -1 is fully left, +1 fully right, 0 centre. */
export function stereoPan(listener, emitter, listenerHeadingDegrees = 0, spatialAudio = true) {
  if (!spatialAudio) return 0;
  const position = hrtfPosition(listener, emitter, listenerHeadingDegrees);
  return clampToRange(position?.x ?? 0, PAN_RANGE);
}

/** Deterministic equal-power stereo gains used by preview and every WAV export. */
export function equalPowerGains(pan) {
  const bounded = clampToRange(pan, PAN_RANGE);
  return [Math.sqrt((1 - bounded) / 2), Math.sqrt((1 + bounded) / 2)];
}
