import { buildReflectionPaths, gainToDecibels, reflectionPathGain } from './audio-model.js';
import { createFdnConfiguration } from './fdn.js';
import { directSoundMetrics, hasDistinctDirectArrival, reflectionPathMetrics } from './geo.js';
import { synthesizeLateReverb } from './late-reverb.js';
import { hrtfPosition } from './spatial.js';
import { WAV_SAMPLE_RATE } from './wav.js';

export const EXPORT_LEVEL_POLICY = Object.freeze({ normalization: false, clipping: false, limiter: false });

const stereo = length => [new Float32Array(length), new Float32Array(length)];
const panGains = pan => [Math.sqrt((1 - pan) / 2), Math.sqrt((1 + pan) / 2)];

export function createDirectArrivalEvent({ source, listener, sampleRate = WAV_SAMPLE_RATE }) {
  const metrics = directSoundMetrics(source, listener);
  return {
    frame: hasDistinctDirectArrival(source, listener) ? Math.round(metrics.propagationSeconds * sampleRate) : 0,
    gain: hasDistinctDirectArrival(source, listener) ? Math.max(.18, Math.min(.72, 140 / Math.max(140, metrics.pathMetres))) : .8,
    emitter: source
  };
}

export function createEarlyArrivalEvents({ source, listener, reflectors, settings, sampleRate = WAV_SAMPLE_RATE }) {
  return buildReflectionPaths(reflectors, { maxBounces: Math.min(2, settings.maxBounces), maxPaths: settings.earlyPathLimit, thresholdDb: settings.cutoffDb }).flatMap(path => {
    const metrics = reflectionPathMetrics(source, listener, path);
    const attenuation = Math.max(.12, Math.min(.65, 140 / Math.max(140, metrics.pathMetres)));
    const gain = reflectionPathGain(attenuation, path);
    return gainToDecibels(gain) < settings.cutoffDb ? [] : [{ frame: Math.round(metrics.propagationSeconds * sampleRate), gain, emitter: path.at(-1), reflectorIds: path.map(reflector => reflector.id) }];
  });
}

function addMono(channels, mono, startFrame, gain, pan) {
  const gains = panGains(Math.max(-1, Math.min(1, pan)));
  for (let frame = 0; frame < mono.length && startFrame + frame < channels[0].length; frame += 1) {
    channels[0][startFrame + frame] += mono[frame] * gain * gains[0];
    channels[1][startFrame + frame] += mono[frame] * gain * gains[1];
  }
}

function addStereo(target, source, startFrame = 0, gain = 1) {
  source.forEach((channel, channelIndex) => {
    for (let frame = 0; frame < channel.length && startFrame + frame < target[channelIndex].length; frame += 1) {
      target[channelIndex][startFrame + frame] += channel[frame] * gain;
    }
  });
}

export function resampleToMono(audioBuffer, sampleRate = WAV_SAMPLE_RATE) {
  const length = Math.max(1, Math.ceil(audioBuffer.duration * sampleRate));
  const output = new Float32Array(length);
  for (let frame = 0; frame < length; frame += 1) {
    const position = frame * audioBuffer.sampleRate / sampleRate;
    const before = Math.min(audioBuffer.length - 1, Math.floor(position));
    const after = Math.min(audioBuffer.length - 1, before + 1);
    const mix = position - before;
    for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
      const data = audioBuffer.getChannelData(channel);
      output[frame] += (data[before] + (data[after] - data[before]) * mix) / audioBuffer.numberOfChannels;
    }
  }
  return output;
}

export function renderFdnImpulse(configuration, frameCount) {
  const output = stereo(frameCount);
  const buffers = configuration.delaySamples.map(length => new Float32Array(length));
  const indices = configuration.delaySamples.map(() => 0);
  const filtered = configuration.delaySamples.map(() => 0);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const dry = frame === 0 ? 1 : 0;
    const taps = buffers.map((buffer, index) => {
      const value = buffer[indices[index]];
      filtered[index] += (value - filtered[index]) * (1 - configuration.damping * .94);
      return filtered[index];
    });
    const mixed = taps.slice();
    for (let span = 1; span < mixed.length; span *= 2) for (let start = 0; start < mixed.length; start += span * 2) for (let index = 0; index < span; index += 1) {
      const a = mixed[start + index]; const b = mixed[start + index + span];
      mixed[start + index] = a + b; mixed[start + index + span] = a - b;
    }
    buffers.forEach((buffer, index) => {
      buffer[indices[index]] = dry * (.12 + configuration.density * .2) * (index % 2 ? -1 : 1)
        + mixed[index] / Math.sqrt(mixed.length) * configuration.feedback[index];
      indices[index] = (indices[index] + 1) % buffer.length;
      output[0][frame] += taps[index] * configuration.outputGains[index][0] * .16;
      output[1][frame] += taps[index] * configuration.outputGains[index][1] * .16;
    });
  }
  return output;
}

async function convolve(inputMono, impulse, frameCount, sampleRate) {
  if (typeof OfflineAudioContext !== 'undefined') {
    const context = new OfflineAudioContext(2, frameCount, sampleRate);
    const source = context.createBufferSource();
    source.buffer = context.createBuffer(1, inputMono.length, sampleRate);
    source.buffer.copyToChannel(inputMono, 0);
    const convolver = context.createConvolver();
    convolver.normalize = false;
    convolver.buffer = context.createBuffer(2, impulse[0].length, sampleRate);
    impulse.forEach((channel, index) => convolver.buffer.copyToChannel(channel, index));
    source.connect(convolver).connect(context.destination);
    source.start(0);
    const rendered = await context.startRendering();
    const output = [new Float32Array(rendered.getChannelData(0)), new Float32Array(rendered.getChannelData(1))];
    const expectedSignal = inputMono.some(Boolean) && impulse.some(channel => channel.some(Boolean));
    if (!expectedSignal || output.some(channel => channel.some(Boolean))) return output;
    return convolveFft(inputMono, impulse, frameCount);
  }
  const output = stereo(frameCount);
  for (let inputFrame = 0; inputFrame < inputMono.length; inputFrame += 1) if (inputMono[inputFrame]) addStereo(output, impulse, inputFrame, inputMono[inputFrame]);
  return output;
}

function fft(real, imaginary, inverse = false) {
  const length = real.length;
  for (let index = 1, reversed = 0; index < length; index += 1) {
    let bit = length >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
    }
  }
  for (let size = 2; size <= length; size *= 2) {
    const angle = (inverse ? 2 : -2) * Math.PI / size;
    const stepReal = Math.cos(angle); const stepImaginary = Math.sin(angle);
    for (let start = 0; start < length; start += size) {
      let rotationReal = 1; let rotationImaginary = 0;
      for (let offset = 0; offset < size / 2; offset += 1) {
        const even = start + offset; const odd = even + size / 2;
        const oddReal = real[odd] * rotationReal - imaginary[odd] * rotationImaginary;
        const oddImaginary = real[odd] * rotationImaginary + imaginary[odd] * rotationReal;
        real[odd] = real[even] - oddReal; imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal; imaginary[even] += oddImaginary;
        const nextReal = rotationReal * stepReal - rotationImaginary * stepImaginary;
        rotationImaginary = rotationReal * stepImaginary + rotationImaginary * stepReal;
        rotationReal = nextReal;
      }
    }
  }
  if (inverse) for (let index = 0; index < length; index += 1) { real[index] /= length; imaginary[index] /= length; }
}

export function convolveFft(inputMono, impulse, frameCount) {
  let fftLength = 1;
  const convolutionLength = inputMono.length + impulse[0].length - 1;
  while (fftLength < convolutionLength) fftLength *= 2;
  const inputReal = new Float64Array(fftLength); const inputImaginary = new Float64Array(fftLength);
  inputReal.set(inputMono); fft(inputReal, inputImaginary);
  return impulse.map(channel => {
    const real = new Float64Array(fftLength); const imaginary = new Float64Array(fftLength);
    real.set(channel); fft(real, imaginary);
    for (let index = 0; index < fftLength; index += 1) {
      const productReal = real[index] * inputReal[index] - imaginary[index] * inputImaginary[index];
      imaginary[index] = real[index] * inputImaginary[index] + imaginary[index] * inputReal[index];
      real[index] = productReal;
    }
    fft(real, imaginary, true);
    const output = new Float32Array(frameCount);
    output.set(real.subarray(0, Math.min(frameCount, convolutionLength)));
    return output;
  });
}

function convolveSparse(inputMono, impulse, frameCount) {
  const output = stereo(frameCount);
  impulse.forEach((channel, channelIndex) => {
    for (let impulseFrame = 0; impulseFrame < channel.length; impulseFrame += 1) {
      const gain = channel[impulseFrame];
      if (!gain) continue;
      for (let inputFrame = 0; inputFrame < inputMono.length && impulseFrame + inputFrame < frameCount; inputFrame += 1) {
        output[channelIndex][impulseFrame + inputFrame] += inputMono[inputFrame] * gain;
      }
    }
  });
  return output;
}

export async function renderExportAudio({ source, listener, reflectors, heading, settings, distanceMetres, inputMono, sampleRate = WAV_SAMPLE_RATE }) {
  const responseSeconds = settings.durationSeconds;
  const fdnSeconds = settings.fdnTailSeconds * 1.25;
  const earlyEvents = createEarlyArrivalEvents({ source, listener, reflectors, settings, sampleRate });
  const latestEarlyFrame = earlyEvents.reduce((latest, event) => Math.max(latest, event.frame), 0);
  const irFrames = Math.max(Math.ceil(responseSeconds * sampleRate), earlyEvents.length ? latestEarlyFrame + 1 : 0);
  const fdnFrames = Math.max(Math.ceil(fdnSeconds * sampleRate), earlyEvents.length ? latestEarlyFrame + 1 : 0);
  const earlyIr = stereo(irFrames);
  const sourcePan = settings.spatialAudio === false ? 0 : hrtfPosition(listener, source, heading)?.x ?? 0;
  for (const event of earlyEvents) {
    const pan = settings.spatialAudio === false ? 0 : hrtfPosition(listener, event.emitter, heading)?.x ?? 0;
    addMono(earlyIr, new Float32Array([1]), event.frame, event.gain, pan);
  }
  const lateIr = synthesizeLateReverb({ sampleRate, source, listener, reflectors, heading, distanceMetres, durationSeconds: responseSeconds, maxBounces: settings.maxBounces, walkCount: settings.lateWalks, cutoffDb: settings.cutoffDb, decayScale: 1.1 - settings.tailPersistence, spatialAudio: settings.spatialAudio !== false });
  const convolutionIr = stereo(irFrames);
  addStereo(convolutionIr, earlyIr);
  addStereo(convolutionIr, lateIr, 0, .7);
  const fdnConfiguration = createFdnConfiguration({ sampleRate, source, listener, reflectors, heading, distanceMetres, tailSeconds: settings.fdnTailSeconds, density: settings.fdnDensity, damping: settings.fdnDamping, geometryInfluence: settings.geometryInfluence });
  if (settings.spatialAudio === false) fdnConfiguration.outputGains = fdnConfiguration.outputGains.map(() => [Math.SQRT1_2, Math.SQRT1_2]);
  const fdnLateIr = reflectors.length >= 2 ? renderFdnImpulse(fdnConfiguration, fdnFrames) : stereo(fdnFrames);
  const fdnIr = stereo(fdnFrames);
  addStereo(fdnIr, earlyIr);
  addStereo(fdnIr, fdnLateIr, 0, .65);

  const lateForRender = settings.lateMode === 'fdn' ? fdnLateIr : lateIr;
  const directEvent = createDirectArrivalEvent({ source, listener, sampleRate });
  const directFrame = directEvent.frame;
  const timelineFrames = Math.max(1, inputMono.length + Math.max(irFrames, fdnFrames) - 1, directFrame + inputMono.length);
  const directArrival = stereo(timelineFrames);
  addMono(directArrival, inputMono, directFrame, directEvent.gain, sourcePan);
  const direct = stereo(timelineFrames);
  if (directFrame > 0) addMono(direct, inputMono, 0, .8, 0);
  addStereo(direct, directArrival);
  const early = convolveSparse(inputMono, earlyIr, timelineFrames);
  const late = await convolve(inputMono, lateForRender, timelineFrames, sampleRate);
  const lateGain = settings.lateMode === 'fdn' ? .65 : .7;
  late.forEach(channel => channel.forEach((value, frame) => { channel[frame] = value * lateGain; }));
  const wet = stereo(timelineFrames); addStereo(wet, directArrival); addStereo(wet, early); addStereo(wet, late);
  return { convolutionIr, fdnIr, wet, direct, directArrival, early, late, sampleRate, responseSeconds, fdnSeconds, timelineSeconds: timelineFrames / sampleRate };
}
