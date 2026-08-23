import { createDirectArrivalEvent, createEarlyArrivalEvents } from './arrivals.js';
import { SOURCE_ONSET_GAIN } from './audio-model.js';
import { exportFrameLayout, fdnResponseSeconds, lateFieldGain } from './export-layout.js';
import { createFdnConfiguration } from './fdn.js';
import { synthesizeLateReverb } from './late-reverb.js';
import { equalPowerGains, stereoPan } from './spatial.js';
import { WAV_SAMPLE_RATE } from './wav.js';

/** One-pole damping applied to every FDN tap before it is fed back. */
const FDN_DAMPING_COEFFICIENT = .94;
/** Excitation and output trims that keep the FDN network below full scale without limiting. */
const FDN_INPUT_GAIN_MINIMUM = .12;
const FDN_INPUT_GAIN_DENSITY_RANGE = .2;
const FDN_OUTPUT_GAIN = .16;
/** Minimum reflector count before a recursive late field exists at all. */
const LATE_FIELD_MINIMUM_REFLECTORS = 2;

const stereo = length => [new Float32Array(length), new Float32Array(length)];

function addMono(channels, mono, startFrame, gain, pan) {
  const gains = equalPowerGains(pan);
  for (let frame = 0; frame < mono.length && startFrame + frame < channels[0].length; frame += 1) {
    channels[0][startFrame + frame] += mono[frame] * gain * gains[0];
    channels[1][startFrame + frame] += mono[frame] * gain * gains[1];
  }
}

export function addStereo(target, source, startFrame = 0, gain = 1) {
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
  const inputGain = FDN_INPUT_GAIN_MINIMUM + configuration.density * FDN_INPUT_GAIN_DENSITY_RANGE;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const dry = frame === 0 ? 1 : 0;
    const taps = buffers.map((buffer, index) => {
      const value = buffer[indices[index]];
      filtered[index] += (value - filtered[index]) * (1 - configuration.damping * FDN_DAMPING_COEFFICIENT);
      return filtered[index];
    });
    const mixed = taps.slice();
    for (let span = 1; span < mixed.length; span *= 2) for (let start = 0; start < mixed.length; start += span * 2) for (let index = 0; index < span; index += 1) {
      const a = mixed[start + index]; const b = mixed[start + index + span];
      mixed[start + index] = a + b; mixed[start + index + span] = a - b;
    }
    buffers.forEach((buffer, index) => {
      buffer[indices[index]] = dry * inputGain * (index % 2 ? -1 : 1)
        + mixed[index] / Math.sqrt(mixed.length) * configuration.feedback[index];
      indices[index] = (indices[index] + 1) % buffer.length;
      output[0][frame] += taps[index] * configuration.outputGains[index][0] * FDN_OUTPUT_GAIN;
      output[1][frame] += taps[index] * configuration.outputGains[index][1] * FDN_OUTPUT_GAIN;
    });
  }
  return output;
}

async function convolve(inputMono, impulse, frameCount, sampleRate) {
  if (typeof OfflineAudioContext === 'undefined') return convolveFft(inputMono, impulse, frameCount);
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

/** Early reflections are single samples, so the sparse impulse side is the cheap loop to walk. */
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

/** Everything a full project export writes. Preview asks for one of these instead. */
export const EXPORT_OUTPUTS = Object.freeze(['convolutionIr', 'fdnIr', 'wet', 'direct', 'directArrival', 'early', 'late']);

const once = build => {
  let value;
  return () => (value ??= build());
};

/**
 * Renders the requested outputs and nothing else: a preview that only needs the wet mix never pays
 * for the impulse responses or the stems, and a convolution late field never renders the FDN.
 */
export async function renderExportAudio({ source, listener, reflectors, heading, settings, distanceMetres, inputMono, sampleRate = WAV_SAMPLE_RATE, outputs = EXPORT_OUTPUTS }) {
  const wanted = new Set(outputs);
  const spatialAudio = settings.spatialAudio !== false;
  const earlyEvents = createEarlyArrivalEvents({ source, listener, reflectors, settings, sampleRate });
  const directEvent = createDirectArrivalEvent({ source, listener, sampleRate });
  const { convolutionIrFrames, fdnIrFrames, timelineFrames } = exportFrameLayout({
    settings, earlyFrames: earlyEvents.map(event => event.frame), directFrame: directEvent.frame, inputFrames: inputMono.length, sampleRate
  });

  const earlyIr = once(() => {
    const channels = stereo(convolutionIrFrames);
    const impulse = new Float32Array([1]);
    for (const event of earlyEvents) {
      addMono(channels, impulse, event.frame, event.gain, stereoPan(listener, event.emitter, heading, spatialAudio));
    }
    return channels;
  });

  const convolutionLateIr = once(() => synthesizeLateReverb({
    sampleRate, source, listener, reflectors, heading, distanceMetres, durationSeconds: settings.durationSeconds,
    maxBounces: settings.maxBounces, walkCount: settings.lateWalks, cutoffDb: settings.cutoffDb,
    decayScale: 1.1 - settings.tailPersistence, spatialAudio
  }));

  const fdnLateIr = once(() => {
    if (reflectors.length < LATE_FIELD_MINIMUM_REFLECTORS) return stereo(fdnIrFrames);
    const configuration = createFdnConfiguration({
      sampleRate, source, listener, reflectors, heading, distanceMetres, tailSeconds: settings.fdnTailSeconds,
      density: settings.fdnDensity, damping: settings.fdnDamping, geometryInfluence: settings.geometryInfluence
    });
    if (!spatialAudio) configuration.outputGains = configuration.outputGains.map(() => [Math.SQRT1_2, Math.SQRT1_2]);
    return renderFdnImpulse(configuration, fdnIrFrames);
  });

  const selectedLateIr = () => settings.lateMode === 'fdn' ? fdnLateIr() : convolutionLateIr();

  const directArrival = once(() => {
    const channels = stereo(timelineFrames);
    addMono(channels, inputMono, directEvent.frame, directEvent.gain, stereoPan(listener, source, heading, spatialAudio));
    return channels;
  });

  const rendered = {
    sampleRate,
    responseSeconds: settings.durationSeconds,
    fdnSeconds: fdnResponseSeconds(settings),
    timelineSeconds: timelineFrames / sampleRate
  };

  if (wanted.has('convolutionIr')) {
    const channels = stereo(convolutionIrFrames);
    addStereo(channels, earlyIr());
    addStereo(channels, convolutionLateIr(), 0, lateFieldGain('convolution'));
    rendered.convolutionIr = channels;
  }
  if (wanted.has('fdnIr')) {
    const channels = stereo(fdnIrFrames);
    addStereo(channels, earlyIr());
    addStereo(channels, fdnLateIr(), 0, lateFieldGain('fdn'));
    rendered.fdnIr = channels;
  }
  if (wanted.has('direct')) {
    const channels = stereo(timelineFrames);
    if (directEvent.frame > 0) addMono(channels, inputMono, 0, SOURCE_ONSET_GAIN, 0);
    addStereo(channels, directArrival());
    rendered.direct = channels;
  }
  if (wanted.has('directArrival')) rendered.directArrival = directArrival();

  const early = wanted.has('early') || wanted.has('wet') ? convolveSparse(inputMono, earlyIr(), timelineFrames) : null;
  let late = null;
  if (wanted.has('late') || wanted.has('wet')) {
    late = await convolve(inputMono, selectedLateIr(), timelineFrames, sampleRate);
    const gain = lateFieldGain(settings.lateMode);
    for (const channel of late) for (let frame = 0; frame < channel.length; frame += 1) channel[frame] *= gain;
  }
  if (wanted.has('early')) rendered.early = early;
  if (wanted.has('late')) rendered.late = late;
  if (wanted.has('wet')) {
    const channels = stereo(timelineFrames);
    addStereo(channels, directArrival()); addStereo(channels, early); addStereo(channels, late);
    rendered.wet = channels;
  }

  return rendered;
}
