import { createDirectArrivalEvent, createEarlyArrivalEvents } from './arrivals.js';
import { exportFrameLayout, lateFieldGain } from './export-layout.js';
import { DISTANCE_METHOD, EARTH_RADIUS_METRES, SPEED_OF_SOUND_METRES_PER_SECOND } from './geo.js';
import { WAV_CHANNELS, WAV_FORMAT, WAV_SAMPLE_RATE } from './wav.js';

export const PROJECT_FORMAT = 'echotect-project';
export const PROJECT_SCHEMA_VERSION = '1.1.0';

const point = value => ({ latitudeDegrees: value.latitude, longitudeDegrees: value.longitude });

export function createProjectManifest({ projectId, projectName, createdAt, source, listener, reflectors, globalReflectionLevelDb, globalMaterial, pointsLinked, heading, echoField, echoFieldSettings, inputName, inputDurationSeconds }) {
  const direct = createDirectArrivalEvent({ source, listener });
  const earlyPaths = createEarlyArrivalEvents({ source, listener, reflectors, settings: echoFieldSettings });
  const inputFrames = Math.ceil(inputDurationSeconds * WAV_SAMPLE_RATE);
  const { convolutionIrFrames, fdnIrFrames, timelineFrames } = exportFrameLayout({
    settings: echoFieldSettings, earlyFrames: earlyPaths.map(path => path.frame), directFrame: direct.frame, inputFrames
  });
  const renderDurationSeconds = timelineFrames / WAV_SAMPLE_RATE;
  return {
    format: PROJECT_FORMAT,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    project: { id: projectId, name: projectName, createdAt, exportedAt: new Date().toISOString() },
    units: { coordinates: 'decimal-degrees-wgs84', distance: 'metres', time: 'seconds', level: 'decibels-relative-amplitude', audioSample: 'float-full-scale', angle: 'compass-degrees' },
    propagation: { distanceMethod: DISTANCE_METHOD, earthRadiusMetres: EARTH_RADIUS_METRES, speedOfSoundMetresPerSecond: SPEED_OF_SOUND_METRES_PER_SECOND },
    geometry: {
      source: point(source), listener: { ...point(listener), headingDegrees: heading }, pointsLinked,
      reflectors: reflectors.map(reflector => ({
        id: reflector.id, position: point(reflector), levelDb: reflector.levelDb, material: reflector.material,
        effectiveMaterial: reflector.effectiveMaterial, reflectionKind: reflector.reflectionKind ?? 'manual',
        ...(reflector.buildingEdge ? { building: { id: reflector.buildingId ?? null, edge: reflector.buildingEdge, facadeMaterial: reflector.facadeMaterial ?? null } } : {})
      }))
    },
    echoField: { enabled: echoField.enabled, radiusMetres: echoField.radiusMetres, activeSurfaceCount: echoField.activeSurfaceCount },
    levels: { globalReflectionLevelDb, globalMaterial, normalization: false, clipping: false, limiter: false },
    lateField: structuredClone(echoFieldSettings), audioSource: { name: inputName, embedded: false, durationSeconds: inputDurationSeconds },
    derived: {
      direct: { pathMetres: direct.pathMetres, propagationSeconds: direct.propagationSeconds, levelDb: direct.levelDb, arrivalAzimuthDegrees: direct.arrivalAzimuthDegrees },
      earlyPaths: earlyPaths.map(path => ({
        reflectorIds: path.reflectorIds, finalReflectorId: path.finalReflectorId, pathMetres: path.pathMetres,
        propagationSeconds: path.propagationSeconds, levelDb: path.levelDb, arrivalAzimuthDegrees: path.arrivalAzimuthDegrees
      }))
    },
    exports: {
      wav: { sampleRateHz: WAV_SAMPLE_RATE, sampleFormat: WAV_FORMAT, bitsPerSample: 32, channelCount: WAV_CHANNELS, channelLayout: ['left', 'right'], normalization: false, clipping: false, limiter: false, timingOffsetSeconds: 0 },
      convolutionIr: { durationSeconds: convolutionIrFrames / WAV_SAMPLE_RATE, configuredLateFieldDurationSeconds: echoFieldSettings.durationSeconds, content: ['early-reflections', 'convolution-late-field'], lateFieldGain: lateFieldGain('convolution'), directIncluded: false },
      renderedFdnIr: { durationSeconds: fdnIrFrames / WAV_SAMPLE_RATE, input: 'unit-impulse', content: ['early-reflections', 'fdn-late-field'], lateFieldGain: lateFieldGain('fdn'), directIncluded: false },
      wetRender: { source: inputName, durationSeconds: renderDurationSeconds, content: ['direct-arrival', 'early', echoFieldSettings.lateMode === 'fdn' ? 'fdn-late-field' : 'convolution-late-field'], triggerIncluded: false, directIncluded: true, lateFieldGain: lateFieldGain(echoFieldSettings.lateMode) },
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
  if (!Number.isFinite(manifest?.derived?.direct?.levelDb)) errors.push('derived.direct.levelDb must be a finite number');
  if (manifest?.exports?.wav?.sampleRateHz !== WAV_SAMPLE_RATE || manifest?.exports?.wav?.sampleFormat !== WAV_FORMAT || manifest?.exports?.wav?.channelCount !== WAV_CHANNELS) errors.push('unsupported WAV export contract');
  return { valid: errors.length === 0, errors };
}
