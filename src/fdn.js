import { propagationSeconds } from './geo.js';
import { clampToRange } from './range.js';
import { equalPowerGains, stereoPan } from './spatial.js';

/** Neutral delay-line lengths, blended with the geometry by geometryInfluence. */
const BASE_DELAYS_MS = [29.7, 37.1, 41.1, 43.7, 47.9, 53.3, 59.3, 67.7];
/** Measured path times are folded into this window so distant geometry still forms a dense tail. */
const FOLDED_DELAY_MINIMUM_SECONDS = .018;
const FOLDED_DELAY_RANGE_SECONDS = .105;
/** Density stretches every delay line between 70 % and 110 % of its tuned length. */
const DENSITY_LENGTH_MINIMUM = .7;
const DENSITY_LENGTH_RANGE = .4;
const MINIMUM_DELAY_SAMPLES = 2;
/** Three decades of amplitude, that is −60 dB, over the requested tail length. */
const DECAY_DECADES_PER_TAIL = 3;
const MAXIMUM_FEEDBACK = .995;
/** Neutral stereo placement, blended with the geometry by geometryInfluence. */
const BASE_PANS = [-.82, .63, -.38, .9, .28, -.68, .48, -.12];
const DAMPING_RANGE = Object.freeze({ minimum: .02, maximum: .98 });
const DENSITY_RANGE = Object.freeze({ minimum: .05, maximum: 1 });

export function createFdnConfiguration({ sampleRate, source, listener, reflectors, heading = 0, distanceMetres, tailSeconds = 8, density = .7, damping = .55, geometryInfluence = .7 }) {
  const geometryDelaySeconds = reflectors.length
    ? reflectors.map(reflector => propagationSeconds(distanceMetres(source, reflector) + distanceMetres(reflector, listener)))
    : [0];
  const delaySamples = BASE_DELAYS_MS.map((milliseconds, index) => {
    const genericSeconds = milliseconds / 1000;
    const measuredSeconds = geometryDelaySeconds[index % geometryDelaySeconds.length];
    const foldedSeconds = FOLDED_DELAY_MINIMUM_SECONDS + measuredSeconds % FOLDED_DELAY_RANGE_SECONDS;
    const seconds = genericSeconds * (1 - geometryInfluence) + foldedSeconds * geometryInfluence;
    return Math.max(MINIMUM_DELAY_SAMPLES, Math.round(seconds * sampleRate * (DENSITY_LENGTH_MINIMUM + density * DENSITY_LENGTH_RANGE)));
  });
  const pans = BASE_PANS.map((pan, index) => {
    const reflector = reflectors[index % reflectors.length];
    const geometryPan = reflector ? stereoPan(listener, reflector, heading) : 0;
    return pan * (1 - geometryInfluence) + geometryPan * geometryInfluence;
  });

  return {
    delaySamples,
    feedback: delaySamples.map(delay => Math.min(MAXIMUM_FEEDBACK, 10 ** (-DECAY_DECADES_PER_TAIL * (delay / sampleRate) / tailSeconds))),
    damping: clampToRange(damping, DAMPING_RANGE),
    density: clampToRange(density, DENSITY_RANGE),
    outputGains: pans.map(equalPowerGains)
  };
}
