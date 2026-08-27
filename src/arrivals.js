import { bandLevelDb, geometryReferencePathMetres, maximumBandLevelDb, pathBandGains, pathFilter } from './acoustics.js';
import { buildEarlyReflectionPaths, reflectionBranchGain, SOURCE_ONSET_GAIN } from './audio-model.js';
import { directSoundMetrics, isDistinctPath, reflectionPathMetrics, soundSpeedMetresPerSecond } from './geo.js';
import { arrivalAzimuthDegrees } from './spatial.js';
import { WAV_SAMPLE_RATE } from './wav.js';

/**
 * The single description of what arrives at the Listener and when. Preview, WAV exports, and the
 * project manifest all read these events, so a declared level always matches the rendered one.
 * Distances are metres, times seconds, levels decibels, azimuths compass degrees.
 */
export function createDirectArrivalEvent({ source, listener, settings = {}, sampleRate = WAV_SAMPLE_RATE }) {
  const metrics = directSoundMetrics(source, listener, soundSpeedMetresPerSecond(settings));
  const distinct = isDistinctPath(metrics.pathMetres);
  const bandGains = distinct
    ? pathBandGains({ pathMetres: metrics.pathMetres, referencePathMetres: metrics.pathMetres, settings, sourceGain: SOURCE_ONSET_GAIN })
    : Array(7).fill(SOURCE_ONSET_GAIN);
  const gain = bandGains[3];
  return {
    frame: distinct ? Math.round(metrics.propagationSeconds * sampleRate) : 0,
    gain,
    levelDb: bandLevelDb(bandGains),
    bandGains,
    filter: pathFilter(bandGains, sampleRate),
    emitter: source,
    pathMetres: metrics.pathMetres,
    propagationSeconds: metrics.propagationSeconds,
    arrivalAzimuthDegrees: arrivalAzimuthDegrees(listener, source)
  };
}

export function createEarlyArrivalEvents({ source, listener, reflectors, settings, sampleRate = WAV_SAMPLE_RATE }) {
  const speedOfSound = soundSpeedMetresPerSecond(settings);
  const directPathMetres = directSoundMetrics(source, listener).pathMetres;
  const firstReflectionPathMetres = reflectors.map(reflector => reflectionPathMetrics(source, listener, [reflector]).pathMetres);
  const referencePathMetres = geometryReferencePathMetres(directPathMetres, firstReflectionPathMetres);
  return buildEarlyReflectionPaths(reflectors, settings).flatMap(path => {
    const metrics = reflectionPathMetrics(source, listener, path, speedOfSound);
    const branchGain = reflectionBranchGain(reflectors.length, path.length);
    const bandGains = pathBandGains({ pathMetres: metrics.pathMetres, referencePathMetres, reflectors: path, settings, sourceGain: SOURCE_ONSET_GAIN * branchGain });
    const gain = bandGains[3];
    const levelDb = bandLevelDb(bandGains);
    if (maximumBandLevelDb(bandGains) < settings.cutoffDb) return [];
    const emitter = path.at(-1);
    return [{
      frame: Math.round(metrics.propagationSeconds * sampleRate),
      gain,
      levelDb,
      bandGains,
      filter: pathFilter(bandGains, sampleRate),
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
