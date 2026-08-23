import { SPEED_OF_SOUND_METRES_PER_SECOND } from './geo.js';
import { hrtfPosition } from './spatial.js';

const BASE_DELAYS_MS = [29.7, 37.1, 41.1, 43.7, 47.9, 53.3, 59.3, 67.7];

export function createFdnConfiguration({ sampleRate, source, listener, reflectors, heading = 0, distanceMetres, tailSeconds = 8, density = .7, damping = .55, geometryInfluence = .7 }) {
  const geometryDelays = reflectors.length
    ? reflectors.map(reflector => (distanceMetres(source, reflector) + distanceMetres(reflector, listener)) / SPEED_OF_SOUND_METRES_PER_SECOND)
    : [0];
  const delaySamples = BASE_DELAYS_MS.map((milliseconds, index) => {
    const genericSeconds = milliseconds / 1000;
    const measuredSeconds = geometryDelays[index % geometryDelays.length];
    const foldedSeconds = .018 + (measuredSeconds % .105);
    const seconds = genericSeconds * (1 - geometryInfluence) + foldedSeconds * geometryInfluence;
    return Math.max(2, Math.round(seconds * sampleRate * (.7 + density * .4)));
  });
  const defaultPans = [-.82, .63, -.38, .9, .28, -.68, .48, -.12];
  const pans = defaultPans.map((pan, index) => {
    const reflector = reflectors[index % reflectors.length];
    const geometryPan = reflector ? Math.max(-1, Math.min(1, hrtfPosition(listener, reflector, heading)?.x ?? 0)) : 0;
    return pan * (1 - geometryInfluence) + geometryPan * geometryInfluence;
  });

  return {
    delaySamples,
    feedback: delaySamples.map(delay => Math.min(.995, 10 ** (-3 * (delay / sampleRate) / tailSeconds))),
    damping: Math.max(.02, Math.min(.98, damping)),
    density: Math.max(.05, Math.min(1, density)),
    outputGains: pans.map(pan => [Math.sqrt((1 - pan) / 2), Math.sqrt((1 + pan) / 2)]),
    tailSamples: Math.round(sampleRate * tailSeconds * 1.25)
  };
}
