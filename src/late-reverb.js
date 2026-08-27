import { geometryReferencePathMetres, maximumBandLevelDb, OCTAVE_BAND_HZ, pathBandGains, renderOctaveBandImpulse } from './acoustics.js';
import { SOURCE_ONSET_GAIN } from './audio-model.js';
import { propagationSeconds, soundSpeedMetresPerSecond } from './geo.js';
import { equalPowerGains, stereoPan } from './spatial.js';

/** Each sampled arrival is spread over three samples so dense walks do not sound granular. */
const ARRIVAL_KERNEL = [1, .55, .22];
/** A walk needs a different reflector to continue; this bounds the search before it gives up. */
const NEXT_REFLECTOR_ATTEMPTS = 5;

function geometrySeed(source, listener, reflectors) {
  const values = [source, listener, ...reflectors].flatMap(point => [point.latitude, point.longitude]);
  return values.reduce((hash, value) => Math.imul(hash ^ Math.round(value * 1e6), 16777619), 2166136261) >>> 0;
}

function randomGenerator(seed) {
  let value = seed || 1;
  return () => {
    value += 0x6d2b79f5;
    let mixed = value;
    mixed = Math.imul(mixed ^ mixed >>> 15, mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ mixed >>> 7, mixed | 61);
    return ((mixed ^ mixed >>> 14) >>> 0) / 4294967296;
  };
}

function addArrival(bandChannels, sample, bandGains, pan, random) {
  if (sample < 0 || sample >= bandChannels[0][0].length) return;
  const gains = equalPowerGains(pan);
  const polarity = random() < .5 ? -1 : 1;
  bandChannels.forEach((channels, band) => ARRIVAL_KERNEL.forEach((weight, offset) => {
    if (sample + offset >= channels[0].length) return;
    channels[0][sample + offset] += bandGains[band] * gains[0] * polarity * weight;
    channels[1][sample + offset] += bandGains[band] * gains[1] * polarity * weight;
  }));
}

export function synthesizeLateReverb({ sampleRate, source, listener, reflectors, heading, distanceMetres, durationSeconds = 10, maxBounces = 32, walkCount = 8192, cutoffDb = -90, spatialAudio = true, settings = {}, diffuseEnergyRetention = .6, onArrival = null }) {
  const length = Math.ceil(sampleRate * durationSeconds);
  const channels = [new Float32Array(length), new Float32Array(length)];
  if (reflectors.length < 2) return channels;

  const bandChannels = OCTAVE_BAND_HZ.map(() => [new Float32Array(length), new Float32Array(length)]);

  const random = randomGenerator(geometrySeed(source, listener, reflectors));
  const boundedWalkCount = Math.max(1, walkCount);
  const walkNormalization = Math.sqrt(boundedWalkCount);
  const visibility = settings.buildingOcclusion
    ? new Map(reflectors.map(reflector => [reflector.id, Array.isArray(reflector.visibleReflectorIds)
      ? new Set(reflector.visibleReflectorIds)
      : null]))
    : null;
  const speedOfSound = soundSpeedMetresPerSecond(settings);
  const referencePathMetres = geometryReferencePathMetres(distanceMetres(source, listener),
    reflectors.map(reflector => distanceMetres(source, reflector) + distanceMetres(reflector, listener)));
  for (let walk = 0; walk < boundedWalkCount; walk += 1) {
    let current = reflectors[Math.floor(random() * reflectors.length)];
    const path = [current];
    let travelledMetres = distanceMetres(source, current);
    for (let bounce = 1; bounce <= maxBounces; bounce += 1) {
      const arrivalSeconds = propagationSeconds(travelledMetres + distanceMetres(current, listener), speedOfSound);
      if (arrivalSeconds >= durationSeconds) break;
      const diffuseGain = diffuseEnergyRetention ** ((bounce - 1) / 2);
      const audibleBandGains = pathBandGains({
        pathMetres: travelledMetres + distanceMetres(current, listener), referencePathMetres, reflectors: path, settings,
        sourceGain: SOURCE_ONSET_GAIN * diffuseGain
      });
      if (maximumBandLevelDb(audibleBandGains) < cutoffDb) break;
      const bandGains = audibleBandGains.map(gain => gain / walkNormalization);
      if (bounce >= 2) {
        onArrival?.({
          reflectorId: current.id,
          previousReflectorId: path.at(-2)?.id ?? null,
          seconds: propagationSeconds(travelledMetres, speedOfSound),
          levelDb: maximumBandLevelDb(audibleBandGains),
          bounce
        });
        addArrival(bandChannels, Math.round(arrivalSeconds * sampleRate), bandGains, stereoPan(listener, current, heading, spatialAudio), random);
      }

      let next = current;
      for (let attempt = 0; attempt < NEXT_REFLECTOR_ATTEMPTS && next.id === current.id; attempt += 1) {
        next = reflectors[Math.floor(random() * reflectors.length)];
        if (visibility?.get(current.id) && !visibility.get(current.id).has(next.id)) next = current;
      }
      if (next.id === current.id) break;
      travelledMetres += distanceMetres(current, next);
      current = next;
      path.push(current);
    }
  }

  for (let channel = 0; channel < 2; channel += 1) {
    channels[channel] = renderOctaveBandImpulse(bandChannels.map(band => band[channel]), sampleRate);
  }
  return channels;
}
