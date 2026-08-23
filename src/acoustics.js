import { MATERIAL_ABSORPTION } from './materials.js';

export const OCTAVE_BAND_HZ = Object.freeze([125, 250, 500, 1000, 2000, 4000, 8000]);
export const STANDARD_ATMOSPHERE = Object.freeze({ temperatureCelsius: 20, relativeHumidityPercent: 50, pressureKpa: 101.325 });
const REFERENCE_TEMPERATURE_KELVIN = 293.15;
const TRIPLE_POINT_TEMPERATURE_KELVIN = 273.16;
const REFERENCE_PRESSURE_KPA = 101.325;
const FILTER_LENGTH = 192;

/** ISO 9613-1 pure-tone atmospheric attenuation coefficient in dB/m. */
export function atmosphericAbsorptionDbPerMetre(frequencyHz, { temperatureCelsius, relativeHumidityPercent, pressureKpa }) {
  const temperatureKelvin = temperatureCelsius + 273.15;
  const temperatureRatio = temperatureKelvin / REFERENCE_TEMPERATURE_KELVIN;
  const pressureRatio = pressureKpa / REFERENCE_PRESSURE_KPA;
  const saturationPressureRatio = 10 ** (-6.8346 * (TRIPLE_POINT_TEMPERATURE_KELVIN / temperatureKelvin) ** 1.261 + 4.6151);
  const waterVapourMolarPercent = relativeHumidityPercent * saturationPressureRatio / pressureRatio;
  const oxygenRelaxationHz = pressureRatio * (24 + 40400 * waterVapourMolarPercent * (.02 + waterVapourMolarPercent) / (.391 + waterVapourMolarPercent));
  const nitrogenRelaxationHz = pressureRatio * temperatureRatio ** -.5
    * (9 + 280 * waterVapourMolarPercent * Math.exp(-4.17 * (temperatureRatio ** (-1 / 3) - 1)));
  const classical = 1.84e-11 / pressureRatio * Math.sqrt(temperatureRatio);
  const molecular = temperatureRatio ** -2.5 * (
    .01275 * Math.exp(-2239.1 / temperatureKelvin) / (oxygenRelaxationHz + frequencyHz ** 2 / oxygenRelaxationHz)
    + .1068 * Math.exp(-3352 / temperatureKelvin) / (nitrogenRelaxationHz + frequencyHz ** 2 / nitrogenRelaxationHz)
  );
  return 8.686 * frequencyHz ** 2 * (classical + molecular);
}

export function atmosphereFromSettings(settings = {}) {
  if (settings.airMode !== 'custom') return { ...STANDARD_ATMOSPHERE };
  return {
    temperatureCelsius: settings.airTemperatureCelsius ?? STANDARD_ATMOSPHERE.temperatureCelsius,
    relativeHumidityPercent: settings.airHumidityPercent ?? STANDARD_ATMOSPHERE.relativeHumidityPercent,
    pressureKpa: settings.airPressureKpa ?? STANDARD_ATMOSPHERE.pressureKpa
  };
}

export function atmosphericBandGains(pathMetres, settings = {}) {
  if (settings.airMode === 'off') return OCTAVE_BAND_HZ.map(() => 1);
  const amount = settings.airAbsorptionAmount ?? 1;
  const atmosphere = atmosphereFromSettings(settings);
  return OCTAVE_BAND_HZ.map(frequency => 10 ** (-atmosphericAbsorptionDbPerMetre(frequency, atmosphere) * pathMetres * amount / 20));
}

export function materialBandGains(material, amount = 1) {
  const absorption = MATERIAL_ABSORPTION[material] ?? MATERIAL_ABSORPTION.generic;
  return absorption.map(value => Math.sqrt(Math.max(0, 1 - value)) ** amount);
}

export function geometryReferencePathMetres(directPathMetres, firstReflectionPathMetres = []) {
  if (directPathMetres > 0) return directPathMetres;
  const positive = firstReflectionPathMetres.filter(distance => distance > 0);
  return positive.length ? Math.min(...positive) : 1;
}

/** Broadband reflector level, material absorption, and atmospheric absorption for one path. */
export function pathBandGains({ pathMetres, referencePathMetres = 1, reflectors = [], settings = {}, sourceGain = 1 }) {
  const spreadingAmount = settings.geometricSpreadingAmount ?? 1;
  const spreading = sourceGain * Math.min(1, referencePathMetres / Math.max(1, pathMetres)) ** spreadingAmount;
  const air = atmosphericBandGains(pathMetres, settings);
  const materialAmount = settings.materialColorationAmount ?? 1;
  const gains = air.map(value => value * spreading);
  for (const reflector of reflectors) {
    const broadband = 10 ** (reflector.levelDb / 20);
    const material = materialBandGains(reflector.effectiveMaterial ?? reflector.material, materialAmount);
    for (let band = 0; band < gains.length; band += 1) gains[band] *= broadband * material[band];
  }
  return gains;
}

function biquad(input, coefficients) {
  const output = new Float32Array(input.length);
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  for (let index = 0; index < input.length; index += 1) {
    const x0 = input[index];
    const y0 = coefficients.b0 * x0 + coefficients.b1 * x1 + coefficients.b2 * x2
      - coefficients.a1 * y1 - coefficients.a2 * y2;
    output[index] = y0; x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return output;
}

function highShelf(sampleRate, frequency, gain) {
  const amplitude = Math.sqrt(Math.max(1e-9, gain));
  const omega = 2 * Math.PI * frequency / sampleRate;
  const cosine = Math.cos(omega); const sine = Math.sin(omega);
  const alpha = sine / 2 * Math.sqrt(2);
  const beta = 2 * Math.sqrt(amplitude) * alpha;
  const a0 = (amplitude + 1) - (amplitude - 1) * cosine + beta;
  return {
    b0: amplitude * ((amplitude + 1) + (amplitude - 1) * cosine + beta) / a0,
    b1: -2 * amplitude * ((amplitude - 1) + (amplitude + 1) * cosine) / a0,
    b2: amplitude * ((amplitude + 1) + (amplitude - 1) * cosine - beta) / a0,
    a1: 2 * ((amplitude - 1) - (amplitude + 1) * cosine) / a0,
    a2: ((amplitude + 1) - (amplitude - 1) * cosine - beta) / a0
  };
}

function lowpass(sampleRate, frequency) {
  const omega = 2 * Math.PI * frequency / sampleRate; const cosine = Math.cos(omega); const sine = Math.sin(omega);
  const alpha = sine / Math.sqrt(2); const a0 = 1 + alpha;
  return { b0: (1 - cosine) / 2 / a0, b1: (1 - cosine) / a0, b2: (1 - cosine) / 2 / a0, a1: -2 * cosine / a0, a2: (1 - alpha) / a0 };
}

function highpass(sampleRate, frequency) {
  const omega = 2 * Math.PI * frequency / sampleRate; const cosine = Math.cos(omega); const sine = Math.sin(omega);
  const alpha = sine / Math.sqrt(2); const a0 = 1 + alpha;
  return { b0: (1 + cosine) / 2 / a0, b1: -(1 + cosine) / a0, b2: (1 + cosine) / 2 / a0, a1: -2 * cosine / a0, a2: (1 - alpha) / a0 };
}

function bandpass(sampleRate, frequency) {
  const omega = 2 * Math.PI * frequency / sampleRate; const cosine = Math.cos(omega); const sine = Math.sin(omega);
  const alpha = sine / (2 * Math.SQRT1_2); const a0 = 1 + alpha;
  return { b0: alpha / a0, b1: 0, b2: -alpha / a0, a1: -2 * cosine / a0, a2: (1 - alpha) / a0 };
}

/** Causal minimum-delay filter approximating octave-band path gains with shelving sections. */
export function pathFilter(bandGains, sampleRate, length = FILTER_LENGTH) {
  let impulse = new Float32Array(length);
  impulse[0] = bandGains[0];
  for (let band = 1; band < bandGains.length; band += 1) {
    const previous = Math.max(1e-9, bandGains[band - 1]);
    const transitionHz = Math.sqrt(OCTAVE_BAND_HZ[band - 1] * OCTAVE_BAND_HZ[band]);
    if (transitionHz >= sampleRate * .45) break;
    impulse = biquad(impulse, highShelf(sampleRate, transitionHz, bandGains[band] / previous));
  }
  return impulse;
}

export const bandLevelDb = bandGains => 20 * Math.log10(Math.max(1e-12, bandGains[OCTAVE_BAND_HZ.indexOf(1000)]));
export const maximumBandLevelDb = bandGains => 20 * Math.log10(Math.max(1e-12, ...bandGains));

/** Recombines seven octave-band impulse streams into one broadband channel. */
export function renderOctaveBandImpulse(bandImpulses, sampleRate) {
  const output = new Float32Array(bandImpulses[0].length);
  const activeBands = OCTAVE_BAND_HZ.reduce((count, frequency) => frequency < sampleRate * .45 ? count + 1 : count, 0);
  bandImpulses.slice(0, activeBands).forEach((input, band) => {
    let filtered;
    if (band === 0) filtered = biquad(input, lowpass(sampleRate, Math.sqrt(OCTAVE_BAND_HZ[0] * OCTAVE_BAND_HZ[1])));
    else if (band === activeBands - 1) filtered = biquad(input, highpass(sampleRate, Math.sqrt(OCTAVE_BAND_HZ[band - 1] * OCTAVE_BAND_HZ[band])));
    else filtered = biquad(input, bandpass(sampleRate, OCTAVE_BAND_HZ[band]));
    for (let frame = 0; frame < output.length; frame += 1) output[frame] += filtered[frame];
  });
  return output;
}
