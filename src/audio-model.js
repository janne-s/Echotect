export const AUDIBILITY_THRESHOLD_DB = -90;
export const MAX_REFLECTION_BOUNCES = 32;
export const MAX_REFLECTION_PATHS = 2048;

export function decibelsToGain(decibels) {
  return 10 ** (decibels / 20);
}

export function gainToDecibels(gain) {
  return gain > 0 ? 20 * Math.log10(gain) : -Infinity;
}

export function reflectionPathGain(baseGain, reflectors) {
  const reflectionLevelDb = reflectors.reduce((total, reflector) => total + reflector.levelDb, 0);
  return baseGain * decibelsToGain(reflectionLevelDb);
}

export function buildReflectionPaths(reflectors, { maxBounces = MAX_REFLECTION_BOUNCES, maxPaths = MAX_REFLECTION_PATHS, thresholdDb = AUDIBILITY_THRESHOLD_DB } = {}) {
  const paths = [];
  let frontier = reflectors.map(reflector => [reflector]);

  while (frontier.length && paths.length < maxPaths) {
    const nextFrontier = [];
    for (const path of frontier) {
      if (paths.length >= maxPaths) break;
      const levelDb = path.reduce((total, reflector) => total + reflector.levelDb, 0);
      if (levelDb < thresholdDb) continue;
      paths.push(path);
      if (path.length >= maxBounces) continue;
      for (const reflector of reflectors) {
        if (reflector.id !== path.at(-1).id) nextFrontier.push([...path, reflector]);
      }
    }
    frontier = nextFrontier;
  }

  return paths;
}
