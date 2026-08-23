import { buildReflectionPaths, gainToDecibels, reflectionPathGain } from './audio-model.js';
import { SPEED_OF_SOUND_METRES_PER_SECOND, directSoundMetrics, reflectionPathMetrics } from './geo.js';
import { arrivalAzimuthDegrees } from './spatial.js';
import { WAV_CHANNELS, WAV_FORMAT, WAV_SAMPLE_RATE } from './wav.js';

export const PROJECT_FORMAT = 'echotect-project';
export const PROJECT_SCHEMA_VERSION = '1.0.0';

const point = value => ({ latitudeDegrees: value.latitude, longitudeDegrees: value.longitude });

export function createProjectManifest({ projectId, projectName, createdAt, source, listener, reflectors, globalReflectionLevelDb, globalMaterial, pointsLinked, heading, echoArea, echoField, inputName, inputDurationSeconds }) {
  const direct = directSoundMetrics(source, listener);
  const paths = buildReflectionPaths(reflectors, { maxBounces: Math.min(2, echoField.maxBounces), maxPaths: echoField.earlyPathLimit, thresholdDb: echoField.cutoffDb });
  const convolutionIrFrames = Math.max(Math.ceil(echoField.durationSeconds * WAV_SAMPLE_RATE), paths.length ? Math.max(...paths.map(path => Math.round(reflectionPathMetrics(source, listener, path).propagationSeconds * WAV_SAMPLE_RATE))) + 1 : 0);
  const fdnIrFrames = Math.max(Math.ceil(echoField.fdnTailSeconds * 1.25 * WAV_SAMPLE_RATE), paths.length ? Math.max(...paths.map(path => Math.round(reflectionPathMetrics(source, listener, path).propagationSeconds * WAV_SAMPLE_RATE))) + 1 : 0);
  const inputFrames = Math.ceil(inputDurationSeconds * WAV_SAMPLE_RATE);
  const directFrame = Math.round(direct.propagationSeconds * WAV_SAMPLE_RATE);
  const renderFrames = Math.max(inputFrames + Math.max(convolutionIrFrames, fdnIrFrames) - 1, directFrame + inputFrames);
  const renderDurationSeconds = renderFrames / WAV_SAMPLE_RATE;
  return {
    format: PROJECT_FORMAT,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    project: { id: projectId, name: projectName, createdAt, exportedAt: new Date().toISOString() },
    units: { coordinates: 'decimal-degrees-wgs84', distance: 'metres', time: 'seconds', level: 'decibels-relative-amplitude', audioSample: 'float-full-scale', angle: 'compass-degrees' },
    propagation: { distanceMethod: 'haversine', earthRadiusMetres: 6371008.8, speedOfSoundMetresPerSecond: SPEED_OF_SOUND_METRES_PER_SECOND },
    geometry: {
      source: point(source), listener: { ...point(listener), headingDegrees: heading }, pointsLinked,
      reflectors: reflectors.map(reflector => ({
        id: reflector.id, position: point(reflector), levelDb: reflector.levelDb, material: reflector.material,
        effectiveMaterial: reflector.effectiveMaterial, reflectionKind: reflector.reflectionKind ?? 'manual',
        ...(reflector.buildingEdge ? { building: { id: reflector.buildingId ?? null, edge: reflector.buildingEdge, facadeMaterial: reflector.facadeMaterial ?? null } } : {})
      }))
    },
    echoArea: { enabled: echoArea.enabled, radiusMetres: echoArea.radiusMetres, activeSurfaceCount: echoArea.activeSurfaceCount },
    levels: { globalReflectionLevelDb, globalMaterial, normalization: false, clipping: false, limiter: false },
    lateField: structuredClone(echoField), audioSource: { name: inputName, embedded: false, durationSeconds: inputDurationSeconds },
    derived: {
      direct: { pathMetres: direct.pathMetres, propagationSeconds: direct.propagationSeconds, arrivalAzimuthDegrees: arrivalAzimuthDegrees(listener, source) },
      earlyPaths: paths.map(path => {
        const metrics = reflectionPathMetrics(source, listener, path);
        const distanceGain = Math.max(.12, Math.min(.65, 140 / Math.max(140, metrics.pathMetres)));
        const gain = reflectionPathGain(distanceGain, path);
        return { reflectorIds: path.map(reflector => reflector.id), finalReflectorId: path.at(-1).id, pathMetres: metrics.pathMetres, propagationSeconds: metrics.propagationSeconds, levelDb: gainToDecibels(gain), arrivalAzimuthDegrees: arrivalAzimuthDegrees(listener, path.at(-1)) };
      })
    },
    exports: {
      wav: { sampleRateHz: WAV_SAMPLE_RATE, sampleFormat: WAV_FORMAT, bitsPerSample: 32, channelCount: WAV_CHANNELS, channelLayout: ['left', 'right'], normalization: false, clipping: false, limiter: false, timingOffsetSeconds: 0 },
      convolutionIr: { durationSeconds: convolutionIrFrames / WAV_SAMPLE_RATE, configuredLateFieldDurationSeconds: echoField.durationSeconds, content: ['early-reflections', 'convolution-late-field'], lateFieldGain: 0.7, directIncluded: false },
      renderedFdnIr: { durationSeconds: fdnIrFrames / WAV_SAMPLE_RATE, input: 'unit-impulse', content: ['early-reflections', 'fdn-late-field'], lateFieldGain: 0.65, directIncluded: false },
      wetRender: { source: inputName, durationSeconds: renderDurationSeconds, content: ['direct-arrival', 'early', echoField.lateMode === 'fdn' ? 'fdn-late-field' : 'convolution-late-field'], triggerIncluded: false, directIncluded: true, lateFieldGain: echoField.lateMode === 'fdn' ? 0.65 : 0.7 },
      stems: { alignedStartSeconds: 0, durationSeconds: renderDurationSeconds, files: ['direct', 'early', 'late'], directContent: ['source-onset-trigger', 'direct-arrival'], equalDuration: true }
    }
  };
}

export function validateProjectManifest(manifest) {
  const errors = [];
  if (manifest?.format !== PROJECT_FORMAT) errors.push(`format must be ${PROJECT_FORMAT}`);
  if (manifest?.schemaVersion !== PROJECT_SCHEMA_VERSION) errors.push(`schemaVersion must be ${PROJECT_SCHEMA_VERSION}`);
  if (typeof manifest?.project?.id !== 'string' || !manifest.project.id) errors.push('project.id is required');
  if (typeof manifest?.project?.name !== 'string' || !manifest.project.name.trim()) errors.push('project.name is required');
  if (!Array.isArray(manifest?.geometry?.reflectors)) errors.push('geometry.reflectors must be an array');
  const ids = manifest?.geometry?.reflectors?.map(reflector => reflector.id) ?? [];
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) errors.push('reflector ids must be non-empty and unique');
  if (manifest?.exports?.wav?.sampleRateHz !== WAV_SAMPLE_RATE || manifest?.exports?.wav?.sampleFormat !== WAV_FORMAT || manifest?.exports?.wav?.channelCount !== WAV_CHANNELS) errors.push('unsupported WAV export contract');
  return { valid: errors.length === 0, errors };
}
