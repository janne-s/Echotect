import { propagationSeconds } from './geo.js';
import { clampToRange } from './range.js';
import { equalPowerGains, stereoPan } from './spatial.js';

/** Neutral delay-line lengths, blended with the geometry by geometryInfluence. */
const BASE_DELAYS_MS = [29.7, 37.1, 41.1, 43.7, 47.9, 53.3, 59.3, 67.7];
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

function transitionReflector(reflectors, from, offset, buildingOcclusion) {
  const visible = buildingOcclusion && Array.isArray(from.visibleReflectorIds)
    ? new Set(from.visibleReflectorIds)
    : null;
  for (let step = 1; step < reflectors.length; step += 1) {
    const candidate = reflectors[(offset + step) % reflectors.length];
    if (candidate !== from && (!visible || visible.has(candidate.id))) return candidate;
  }
  return null;
}

function occludedFeedbackMatrix(lineReflectorIds, lineDestinationIds, reflectors) {
  const byId = new Map(reflectors.map(reflector => [reflector.id, reflector]));
  return lineReflectorIds.map(destinationId => {
    const destination = byId.get(destinationId);
    const visible = new Set(destination?.visibleReflectorIds ?? []);
    const connected = lineDestinationIds.map((sourceId, index) => sourceId === destinationId || visible.has(sourceId) ? index : -1).filter(index => index >= 0);
    const gain = connected.length ? 1 / connected.length : 1;
    return lineReflectorIds.map((_, index) => connected.includes(index) ? gain * (index % 2 ? -1 : 1) : 0);
  });
}

export function createFdnConfiguration({ sampleRate, listener, reflectors, heading = 0, distanceMetres, speedOfSound, tailSeconds = 8, density = .7, damping = .55, geometryInfluence = .7, buildingOcclusion = false }) {
  const lineReflectors = BASE_DELAYS_MS.map((_, index) => reflectors.length > BASE_DELAYS_MS.length
    ? reflectors[Math.floor(index * reflectors.length / BASE_DELAYS_MS.length)]
    : reflectors[index % Math.max(1, reflectors.length)] ?? null);
  const lineDestinations = lineReflectors.map(reflector => reflector
    ? transitionReflector(reflectors, reflector, reflectors.indexOf(reflector), buildingOcclusion)
    : null);
  const geometryDelaySeconds = lineReflectors.map((reflector, index) => reflector && lineDestinations[index]
    ? propagationSeconds(distanceMetres(reflector, lineDestinations[index]), speedOfSound)
    : BASE_DELAYS_MS[index] / 1000);
  const delaySamples = BASE_DELAYS_MS.map((milliseconds, index) => {
    const genericSeconds = milliseconds / 1000;
    const measuredSeconds = geometryDelaySeconds[index % geometryDelaySeconds.length];
    const seconds = genericSeconds * (1 - geometryInfluence) + measuredSeconds * geometryInfluence;
    return Math.max(MINIMUM_DELAY_SAMPLES, Math.round(seconds * sampleRate * (DENSITY_LENGTH_MINIMUM + density * DENSITY_LENGTH_RANGE)));
  });
  const pans = BASE_PANS.map((pan, index) => {
    const reflector = lineDestinations[index] ?? lineReflectors[index];
    const geometryPan = reflector ? stereoPan(listener, reflector, heading) : 0;
    return pan * (1 - geometryInfluence) + geometryPan * geometryInfluence;
  });

  const lineReflectorIds = lineReflectors.map((reflector, index) => reflector?.id ?? `line-${index % Math.max(1, reflectors.length)}`);
  const lineDestinationIds = lineDestinations.map((reflector, index) => reflector?.id ?? lineReflectorIds[index]);
  const lineActive = lineDestinations.map(Boolean);
  const reflectorLineIndices = Object.fromEntries(reflectors.flatMap((reflector, index) => reflector.id === undefined ? [] : [[
    reflector.id,
    Math.min(BASE_DELAYS_MS.length - 1, Math.floor(index * BASE_DELAYS_MS.length / reflectors.length))
  ]]));
  return {
    delaySamples,
    feedback: delaySamples.map(delay => Math.min(MAXIMUM_FEEDBACK, 10 ** (-DECAY_DECADES_PER_TAIL * (delay / sampleRate) / tailSeconds))),
    damping: clampToRange(damping, DAMPING_RANGE),
    density: clampToRange(density, DENSITY_RANGE),
    outputGains: pans.map(equalPowerGains),
    lineReflectorIds,
    lineDestinationIds,
    lineActive,
    reflectorLineIndices,
    feedbackMatrix: buildingOcclusion ? occludedFeedbackMatrix(lineReflectorIds, lineDestinationIds, reflectors) : null
  };
}

/** Physical reflection arrivals excite the late network instead of an unrelated frame-zero impulse. */
export function createFdnInjections(earlyEvents, configuration) {
  if (!earlyEvents.length) return [];
  const lineIndices = new Map();
  configuration.lineReflectorIds.forEach((id, index) => {
    if (!configuration.lineActive[index]) return;
    if (!lineIndices.has(id)) lineIndices.set(id, []);
    lineIndices.get(id).push(index);
  });
  const normalization = Math.sqrt(earlyEvents.length);
  return earlyEvents.flatMap(event => {
    const fallbackLine = configuration.reflectorLineIndices?.[event.finalReflectorId];
    const lines = lineIndices.get(event.finalReflectorId)
      ?? (Number.isInteger(fallbackLine) && configuration.lineActive[fallbackLine] ? [fallbackLine] : null);
    if (!lines?.length) return [];
    const bounceBlend = Math.min(1, .18 + .16 * Math.max(0, event.reflectorIds.length - 1));
    const gain = event.gain * bounceBlend / normalization / Math.sqrt(lines.length);
    return lines.map((line, index) => ({
      frame: event.frame,
      line,
      gain: gain * (index % 2 ? -1 : 1),
      reflectorId: event.finalReflectorId,
      previousReflectorId: event.reflectorIds.at(-2) ?? null
    }));
  });
}
