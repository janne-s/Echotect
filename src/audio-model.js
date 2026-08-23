import { clampToRange } from './range.js';

export const AUDIBILITY_THRESHOLD_DB = -90;
export const MAX_REFLECTION_BOUNCES = 32;
export const MAX_REFLECTION_PATHS = 2048;

/** Early reflections are traced to this bounce depth; deeper paths belong to the late field. */
export const EARLY_PATH_MAX_BOUNCES = 2;

/** Distance in metres below which a path is not attenuated further. */
export const REFERENCE_DISTANCE_METRES = 140;

/** Level of the source onset trigger, and of a direct arrival that is co-located with the Listener. */
export const SOURCE_ONSET_GAIN = .8;

const DIRECT_GAIN_RANGE = Object.freeze({ minimum: .18, maximum: .72 });
const EARLY_GAIN_RANGE = Object.freeze({ minimum: .12, maximum: .65 });

export function decibelsToGain(decibels) {
  return 10 ** (decibels / 20);
}

export function gainToDecibels(gain) {
  return gain > 0 ? 20 * Math.log10(gain) : -Infinity;
}

/** Unclamped distance law shared by direct, early, and late arrivals. */
export function distanceAttenuation(pathMetres) {
  return REFERENCE_DISTANCE_METRES / Math.max(REFERENCE_DISTANCE_METRES, pathMetres);
}

export function directArrivalGain(pathMetres) {
  return clampToRange(distanceAttenuation(pathMetres), DIRECT_GAIN_RANGE);
}

export function earlyPathGain(pathMetres) {
  return clampToRange(distanceAttenuation(pathMetres), EARLY_GAIN_RANGE);
}

export function reflectionPathGain(baseGain, reflectors) {
  const reflectionLevelDb = reflectors.reduce((total, reflector) => total + reflector.levelDb, 0);
  return baseGain * decibelsToGain(reflectionLevelDb);
}

/**
 * Breadth-first reflection paths, in manifest order. A path is only extended while it stays above
 * the audibility threshold and while the result can still fit inside maxPaths, so the search never
 * builds a level it cannot use.
 */
export function buildReflectionPaths(reflectors, { maxBounces = MAX_REFLECTION_BOUNCES, maxPaths = MAX_REFLECTION_PATHS, thresholdDb = AUDIBILITY_THRESHOLD_DB } = {}) {
  const paths = [];
  const audible = reflectors.filter(reflector => reflector.levelDb >= thresholdDb);
  let frontier = audible.map(reflector => ({ path: [reflector], levelDb: reflector.levelDb }));

  while (frontier.length && paths.length < maxPaths) {
    const nextFrontier = [];
    for (const { path, levelDb } of frontier) {
      if (paths.length >= maxPaths) break;
      paths.push(path);
      if (path.length >= maxBounces) continue;
      const lastId = path.at(-1).id;
      for (const reflector of audible) {
        if (paths.length + nextFrontier.length >= maxPaths) break;
        const extendedLevelDb = levelDb + reflector.levelDb;
        if (reflector.id === lastId || extendedLevelDb < thresholdDb) continue;
        nextFrontier.push({ path: [...path, reflector], levelDb: extendedLevelDb });
      }
    }
    frontier = nextFrontier;
  }

  return paths;
}

/** The early-reflection path set shared by the browser preview, the WAV exports, and the manifest. */
export function buildEarlyReflectionPaths(reflectors, settings) {
  return buildReflectionPaths(reflectors, {
    maxBounces: Math.min(EARLY_PATH_MAX_BOUNCES, settings.maxBounces),
    maxPaths: settings.earlyPathLimit,
    thresholdDb: settings.cutoffDb
  });
}
