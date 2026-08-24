import { normalizeEchoFieldSettings } from './echo-field-settings.js';
import { isValidCoordinate } from './geo.js';
import { MATERIAL_LABELS } from './materials.js';
import { boundedValue } from './range.js';

export const WORKSPACE_PROJECT_FORMAT = 'echotect-workspace';
export const REFLECTION_LEVEL_RANGE = Object.freeze({ minimum: -18, maximum: -1, fallback: -6 });

const materialValues = new Set(Object.keys(MATERIAL_LABELS));
const validEdge = edge => Array.isArray(edge) && edge.length === 2
  && edge.every(point => Array.isArray(point) && point.length >= 2 && point.every(Number.isFinite));

function projectReflector(value) {
  if (!isValidCoordinate(value) || typeof value.id !== 'string' || !value.id) throw new Error('Project reflectors require a position and an id.');
  return {
    id: value.id,
    latitude: value.latitude,
    longitude: value.longitude,
    levelDb: boundedValue(value.levelDb, REFLECTION_LEVEL_RANGE),
    material: materialValues.has(value.material) ? value.material : 'inherit',
    ...(validEdge(value.buildingEdge) ? { buildingEdge: value.buildingEdge } : {}),
    ...(typeof value.buildingId === 'string' || typeof value.buildingId === 'number' ? { buildingId: value.buildingId } : {}),
    ...(typeof value.facadeMaterial === 'string' ? { facadeMaterial: value.facadeMaterial } : {}),
    ...(['specular', 'diffuse'].includes(value.reflectionKind) ? { reflectionKind: value.reflectionKind } : {})
  };
}

function reflectorList(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const reflectors = value.map(projectReflector);
  if (new Set(reflectors.map(reflector => reflector.id)).size !== reflectors.length) throw new Error(`${label} ids must be unique.`);
  return reflectors;
}

export function createWorkspaceProject({ project, source, listener, reflectors, automaticReflectors, pointsLinked, globalReflectionLevelDb, globalMaterial, settings, echoFieldEnabled, mapView, savedAt = new Date().toISOString() }) {
  const manual = reflectorList(reflectors, 'Project reflectors');
  const automatic = reflectorList(automaticReflectors, 'Echo field reflectors');
  if (new Set([...manual, ...automatic].map(reflector => reflector.id)).size !== manual.length + automatic.length) throw new Error('All project reflector ids must be unique.');
  return {
    format: WORKSPACE_PROJECT_FORMAT,
    project: { id: project.id, name: project.name, createdAt: project.createdAt, savedAt },
    mapView,
    geometry: { source, listener, pointsLinked, reflectors: manual, echoFieldReflectors: automatic },
    levels: { globalReflectionLevelDb, globalMaterial },
    monitor: { heading: settings.heading, arrivalsOnly: settings.arrivalsOnly, panningMode: settings.panningMode },
    echoField: { enabled: echoFieldEnabled, radiusMetres: settings.echoFieldRadiusMetres },
    settings: settings.echoField
  };
}

export function parseWorkspaceProject(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('The selected file is not valid JSON.'); }
  if (value?.format !== WORKSPACE_PROJECT_FORMAT) throw new Error('The selected file is not an Echotect project.');
  if (!isValidCoordinate(value.geometry?.source) || !isValidCoordinate(value.geometry?.listener)) throw new Error('Project Source and Listener positions are invalid.');
  if (typeof value.project?.id !== 'string' || !value.project.id || typeof value.project?.name !== 'string' || !value.project.name.trim()) throw new Error('Project identity is invalid.');
  const reflectors = reflectorList(value.geometry.reflectors, 'Project reflectors');
  const automaticReflectors = reflectorList(value.geometry.echoFieldReflectors, 'Echo field reflectors');
  const allIds = [...reflectors, ...automaticReflectors].map(reflector => reflector.id);
  if (new Set(allIds).size !== allIds.length) throw new Error('All project reflector ids must be unique.');
  const globalMaterial = materialValues.has(value.levels?.globalMaterial) && value.levels.globalMaterial !== 'inherit' ? value.levels.globalMaterial : 'generic';
  const heading = boundedValue(value.monitor?.heading, { minimum: 0, maximum: 359, fallback: 0 });
  const radiusMetres = Math.max(10, Number.isFinite(value.echoField?.radiusMetres) ? value.echoField.radiusMetres : 100);
  const mapView = isValidCoordinate(value.mapView) && Number.isFinite(value.mapView.zoom)
    ? { latitude: value.mapView.latitude, longitude: value.mapView.longitude, zoom: Math.max(0, Math.min(24, value.mapView.zoom)) }
    : { ...value.geometry.listener, zoom: 15 };
  return {
    project: { id: value.project.id, name: value.project.name.trim(), createdAt: typeof value.project.createdAt === 'string' ? value.project.createdAt : new Date().toISOString() },
    source: { latitude: value.geometry.source.latitude, longitude: value.geometry.source.longitude },
    listener: { latitude: value.geometry.listener.latitude, longitude: value.geometry.listener.longitude },
    reflectors,
    automaticReflectors,
    pointsLinked: Boolean(value.geometry.pointsLinked),
    globalReflectionLevelDb: boundedValue(value.levels?.globalReflectionLevelDb, REFLECTION_LEVEL_RANGE),
    globalMaterial,
    settings: {
      heading,
      arrivalsOnly: Boolean(value.monitor?.arrivalsOnly),
      panningMode: value.monitor?.panningMode === 'spatial-stereo' ? 'spatial-stereo' : 'hrtf-live',
      echoFieldRadiusMetres: radiusMetres,
      echoField: normalizeEchoFieldSettings(value.settings)
    },
    echoFieldEnabled: Boolean(value.echoField?.enabled),
    mapView
  };
}
