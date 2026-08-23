import { decibelsToGain, distanceAttenuation } from './audio-model.js';
import { propagationSeconds } from './geo.js';
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

function addArrival(channels, sample, amplitude, pan, random) {
  if (sample < 0 || sample >= channels[0].length) return;
  const gains = equalPowerGains(pan);
  const polarity = random() < .5 ? -1 : 1;
  ARRIVAL_KERNEL.forEach((weight, offset) => {
    if (sample + offset >= channels[0].length) return;
    channels[0][sample + offset] += amplitude * gains[0] * polarity * weight;
    channels[1][sample + offset] += amplitude * gains[1] * polarity * weight;
  });
}

export function synthesizeLateReverb({ sampleRate, source, listener, reflectors, heading, distanceMetres, durationSeconds = 10, maxBounces = 32, walkCount = 8192, cutoffDb = -90, decayScale = .5, spatialAudio = true }) {
  const length = Math.ceil(sampleRate * durationSeconds);
  const channels = [new Float32Array(length), new Float32Array(length)];
  if (reflectors.length < 2) return channels;

  const random = randomGenerator(geometrySeed(source, listener, reflectors));
  const boundedWalkCount = Math.max(1, walkCount);
  const walkNormalization = Math.sqrt(boundedWalkCount);
  const audibilityGain = decibelsToGain(cutoffDb);
  for (let walk = 0; walk < boundedWalkCount; walk += 1) {
    let current = reflectors[Math.floor(random() * reflectors.length)];
    let travelledMetres = distanceMetres(source, current);
    let energy = decibelsToGain(current.levelDb);
    for (let bounce = 1; bounce <= maxBounces && energy >= audibilityGain; bounce += 1) {
      const arrivalSeconds = propagationSeconds(travelledMetres + distanceMetres(current, listener));
      if (arrivalSeconds >= durationSeconds) break;
      if (bounce >= 2) {
        const amplitude = energy * distanceAttenuation(travelledMetres) / walkNormalization;
        addArrival(channels, Math.round(arrivalSeconds * sampleRate), amplitude, stereoPan(listener, current, heading, spatialAudio), random);
      }

      let next = current;
      for (let attempt = 0; attempt < NEXT_REFLECTOR_ATTEMPTS && next.id === current.id; attempt += 1) {
        next = reflectors[Math.floor(random() * reflectors.length)];
      }
      if (next.id === current.id) break;
      travelledMetres += distanceMetres(current, next);
      current = next;
      energy *= decibelsToGain(current.levelDb * decayScale);
    }
  }

  return channels;
}
