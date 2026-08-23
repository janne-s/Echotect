import { buildEarlyReflectionPaths, directArrivalGain, earlyPathGain, gainToDecibels, reflectionPathGain, SOURCE_ONSET_GAIN } from './audio-model.js';
import { directSoundMetrics, isDistinctPath, reflectionPathMetrics } from './geo.js';
import { arrivalAzimuthDegrees } from './spatial.js';
import { WAV_SAMPLE_RATE } from './wav.js';

/**
 * The single description of what arrives at the Listener and when. Preview, WAV exports, and the
 * project manifest all read these events, so a declared level always matches the rendered one.
 * Distances are metres, times seconds, levels decibels, azimuths compass degrees.
 */
export function createDirectArrivalEvent({ source, listener, sampleRate = WAV_SAMPLE_RATE }) {
  const metrics = directSoundMetrics(source, listener);
  const distinct = isDistinctPath(metrics.pathMetres);
  const gain = distinct ? directArrivalGain(metrics.pathMetres) : SOURCE_ONSET_GAIN;
  return {
    frame: distinct ? Math.round(metrics.propagationSeconds * sampleRate) : 0,
    gain,
    levelDb: gainToDecibels(gain),
    emitter: source,
    pathMetres: metrics.pathMetres,
    propagationSeconds: metrics.propagationSeconds,
    arrivalAzimuthDegrees: arrivalAzimuthDegrees(listener, source)
  };
}

export function createEarlyArrivalEvents({ source, listener, reflectors, settings, sampleRate = WAV_SAMPLE_RATE }) {
  return buildEarlyReflectionPaths(reflectors, settings).flatMap(path => {
    const metrics = reflectionPathMetrics(source, listener, path);
    const gain = reflectionPathGain(earlyPathGain(metrics.pathMetres), path);
    const levelDb = gainToDecibels(gain);
    if (levelDb < settings.cutoffDb) return [];
    const emitter = path.at(-1);
    return [{
      frame: Math.round(metrics.propagationSeconds * sampleRate),
      gain,
      levelDb,
      emitter,
      reflectorIds: path.map(reflector => reflector.id),
      finalReflectorId: emitter.id,
      pathMetres: metrics.pathMetres,
      propagationSeconds: metrics.propagationSeconds,
      arrivalAzimuthDegrees: arrivalAzimuthDegrees(listener, emitter)
    }];
  });
}

/**
 * What the browser monitor plays. Arrivals only mutes the source onset. When the Source and the
 * Listener are in one place the onset and the direct arrival are the same frame-zero event, so
 * muting the onset silences that event and leaves the reflections to sound alone.
 */
export function monitorArrivalPlan(directEvent, arrivalsOnly) {
  const onsetIsSeparate = directEvent.frame > 0;
  return {
    playOnset: onsetIsSeparate && !arrivalsOnly,
    playDirectArrival: onsetIsSeparate || !arrivalsOnly
  };
}
