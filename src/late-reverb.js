import { SPEED_OF_SOUND_METRES_PER_SECOND } from './geo.js';
import { hrtfPosition } from './spatial.js';

const decibelsToGain = decibels => 10 ** (decibels / 20);

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
  const leftGain = Math.sqrt((1 - pan) / 2);
  const rightGain = Math.sqrt((1 + pan) / 2);
  const polarity = random() < .5 ? -1 : 1;
  const kernel = [1, .55, .22];
  kernel.forEach((weight, offset) => {
    if (sample + offset >= channels[0].length) return;
    channels[0][sample + offset] += amplitude * leftGain * polarity * weight;
    channels[1][sample + offset] += amplitude * rightGain * polarity * weight;
  });
}

export function synthesizeLateReverb({ sampleRate, source, listener, reflectors, heading, distanceMetres, durationSeconds = 10, maxBounces = 32, walkCount = 8192, cutoffDb = -90, decayScale = .5 }) {
  const length = Math.ceil(sampleRate * durationSeconds);
  const channels = [new Float32Array(length), new Float32Array(length)];
  if (reflectors.length < 2) return channels;

  const random = randomGenerator(geometrySeed(source, listener, reflectors));
  const boundedWalkCount = Math.max(1, walkCount);
  const audibilityGain = decibelsToGain(cutoffDb);
  for (let walk = 0; walk < boundedWalkCount; walk += 1) {
    let current = reflectors[Math.floor(random() * reflectors.length)];
    let travelledMetres = distanceMetres(source, current);
    let energy = decibelsToGain(current.levelDb);
    for (let bounce = 1; bounce <= maxBounces && energy >= audibilityGain; bounce += 1) {
      const arrivalSeconds = (travelledMetres + distanceMetres(current, listener)) / SPEED_OF_SOUND_METRES_PER_SECOND;
      if (arrivalSeconds >= durationSeconds) break;
      if (bounce >= 2) {
        const distanceGain = Math.min(1, 140 / Math.max(140, travelledMetres));
        const position = hrtfPosition(listener, current, heading);
        addArrival(channels, Math.round(arrivalSeconds * sampleRate), energy * distanceGain / Math.sqrt(boundedWalkCount), Math.max(-1, Math.min(1, position?.x ?? 0)), random);
      }

      let next = current;
      for (let attempt = 0; attempt < 5 && next.id === current.id; attempt += 1) {
        next = reflectors[Math.floor(random() * reflectors.length)];
      }
      if (next.id === current.id) break;
      travelledMetres += distanceMetres(current, next);
      current = next;
      energy *= decibelsToGain(current.levelDb * decayScale);
    }
  }

  const peak = channels.reduce((maximum, channel) => channel.reduce((channelMaximum, value) => Math.max(channelMaximum, Math.abs(value)), maximum), 0);
  if (peak > .35) channels.forEach(channel => channel.forEach((value, index) => { channel[index] = value * .35 / peak; }));
  return channels;
}

export function createLateReverbBuffer(context, options) {
  const channels = synthesizeLateReverb({ ...options, sampleRate: context.sampleRate });
  const buffer = context.createBuffer(2, channels[0].length, context.sampleRate);
  channels.forEach((channel, index) => buffer.copyToChannel(channel, index));
  return buffer;
}
