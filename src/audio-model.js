export const AUDIBILITY_THRESHOLD_DB = -90;
export const MAX_REFLECTION_BOUNCES = 32;
export const MAX_REFLECTION_PATHS = 2048;

export const SOURCE_ONSET_GAIN = .8;

export function decibelsToGain(decibels) {
  return 10 ** (decibels / 20);
}

export function gainToDecibels(gain) {
  return gain > 0 ? 20 * Math.log10(gain) : -Infinity;
}

export function reflectionBranchGain(reflectorCount, bounceCount) {
  const outgoingBranches = Math.max(1, reflectorCount - 1);
  return outgoingBranches ** (-(bounceCount - 1) / 2);
}

export function buildReflectionPaths(reflectors, { maxBounces = MAX_REFLECTION_BOUNCES, maxPaths = MAX_REFLECTION_PATHS, thresholdDb = AUDIBILITY_THRESHOLD_DB, buildingOcclusion = false } = {}) {
  const paths = [];
  const audible = reflectors.filter(reflector => reflector.levelDb >= thresholdDb);
  const visibility = buildingOcclusion
    ? new Map(audible.map(reflector => [reflector.id, Array.isArray(reflector.visibleReflectorIds)
      ? new Set(reflector.visibleReflectorIds)
      : null]))
    : null;
  let frontier = audible.map(reflector => ({ path: [reflector], levelDb: reflector.levelDb }));

  while (frontier.length && paths.length < maxPaths) {
    const nextFrontier = [];
    for (const { path, levelDb } of frontier) {
      if (paths.length >= maxPaths) break;
      paths.push(path);
      if (path.length >= maxBounces) continue;
      const lastId = path.at(-1).id;
      const visibleIds = visibility?.get(lastId);
      for (const reflector of audible) {
        if (paths.length + nextFrontier.length >= maxPaths) break;
        const extendedLevelDb = levelDb + reflector.levelDb;
        if (reflector.id === lastId || extendedLevelDb < thresholdDb) continue;
        if (visibleIds && !visibleIds.has(reflector.id)) continue;
        nextFrontier.push({ path: [...path, reflector], levelDb: extendedLevelDb });
      }
    }
    frontier = nextFrontier;
  }

  return paths;
}

export function buildEarlyReflectionPaths(reflectors, settings) {
  return buildReflectionPaths(reflectors, {
    maxBounces: settings.pointMaxBounces,
    maxPaths: settings.pointPathLimit,
    thresholdDb: settings.cutoffDb,
    buildingOcclusion: settings.buildingOcclusion
  });
}
