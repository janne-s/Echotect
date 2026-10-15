import { normalizeEchoFieldSettings } from './echo-field-settings.js';
import { isValidCoordinate } from './geo.js';
import { MATERIAL_LABELS } from './materials.js';
import { boundedValue } from './range.js';
import { validStructure } from './structures.js';
import { parseTerrainSpace, serializeTerrainSpace } from './terrain-space.js';

export const WORKSPACE_PROJECT_FORMAT = 'echotect-workspace';
export const DEFAULT_PROJECT_NAME = 'Echotect Project';
export const MAP_HEIGHT_RANGE = Object.freeze({ minimum: .5, maximum: 20000, fallback: 1.7 });
export const DEFAULT_MAP_PLACEMENT = Object.freeze({
  source: Object.freeze({ latitude: 60.16955, longitude: 24.9369 }),
  listener: Object.freeze({ latitude: 60.1707, longitude: 24.9410 }),
  pointsLinked: false,
  heightsMetres: Object.freeze({ source: MAP_HEIGHT_RANGE.fallback, listener: MAP_HEIGHT_RANGE.fallback })
});

export const placementHeights = value => ({
  source: boundedValue(value?.source, MAP_HEIGHT_RANGE),
  listener: boundedValue(value?.listener, MAP_HEIGHT_RANGE)
});

export const reflectorHeight = value => (Number.isFinite(value?.heightMetres) && value.heightMetres > 0 ? { heightMetres: value.heightMetres } : {});
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
    ...reflectorHeight(value),
    ...(validEdge(value.buildingEdge) ? { buildingEdge: value.buildingEdge } : {}),
    ...(typeof value.buildingId === 'string' || typeof value.buildingId === 'number' ? { buildingId: value.buildingId } : {}),
    ...(typeof value.facadeMaterial === 'string' ? { facadeMaterial: value.facadeMaterial } : {}),
    ...(['specular', 'diffuse'].includes(value.reflectionKind) ? { reflectionKind: value.reflectionKind } : {}),
    ...(Array.isArray(value.visibleReflectorIds) ? {
      visibleReflectorIds: [...new Set(value.visibleReflectorIds.filter(id => typeof id === 'string' && id))].slice(0, 4096)
    } : {})
  };
}

function reflectorList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const reflectors = value.map(projectReflector);
  if (new Set(reflectors.map(reflector => reflector.id)).size !== reflectors.length) throw new Error(`${label} ids must be unique.`);
  return reflectors;
}

function structureList(value) {
  if (!Array.isArray(value)) throw new Error('Project structures must be an array.');
  if (value.some(item => !validStructure(item))) throw new Error('Project structures contain invalid geometry.');
  if (new Set(value.map(item => item.id)).size !== value.length) throw new Error('Project structure ids must be unique.');
  return value.map(item => ({
    id: item.id,
    center: { latitude: item.center.latitude, longitude: item.center.longitude },
    verticesMetres: item.verticesMetres.map(point => ({ x: point.x, y: point.y })),
    rotationDegrees: item.rotationDegrees,
    material: materialValues.has(item.material) ? item.material : 'inherit'
  }));
}

function projectBackground(value) {
  if (value == null) return null;
  if (!['image/png', 'image/jpeg', 'image/webp'].some(type => value.dataUrl?.startsWith(`data:${type};base64,`))) throw new Error('Project background image data is invalid.');
  if (!isValidCoordinate(value.center) || !Number.isFinite(value.pixelWidth) || value.pixelWidth <= 0 || !Number.isFinite(value.pixelHeight) || value.pixelHeight <= 0) throw new Error('Project background image geometry is invalid.');
  return {
    name: typeof value.name === 'string' && value.name ? value.name : 'Background image',
    dataUrl: value.dataUrl,
    pixelWidth: value.pixelWidth,
    pixelHeight: value.pixelHeight,
    center: { latitude: value.center.latitude, longitude: value.center.longitude },
    widthMetres: Math.max(1, Math.min(100000, Number.isFinite(value.widthMetres) ? value.widthMetres : 100)),
    rotationDegrees: Math.max(-180, Math.min(180, Number.isFinite(value.rotationDegrees) ? value.rotationDegrees : 0)),
    opacity: Math.max(.1, Math.min(1, Number.isFinite(value.opacity) ? value.opacity : .75))
  };
}

function projectPlacement(value, label) {
  if (value === undefined) value = DEFAULT_MAP_PLACEMENT;
  if (!isValidCoordinate(value?.source) || !isValidCoordinate(value?.listener)) throw new Error(`${label} Source and Listener positions are invalid.`);
  return {
    source: { latitude: value.source.latitude, longitude: value.source.longitude },
    listener: { latitude: value.listener.latitude, longitude: value.listener.longitude },
    pointsLinked: Boolean(value.pointsLinked),
    heightsMetres: placementHeights(value.heightsMetres)
  };
}

function projectTerrainPlacements(value, map) {
  if (value === undefined || value === null) return { exterior: projectPlacement(map, 'Canyon'), interior: projectPlacement(map, 'Chamber') };
  return {
    exterior: projectPlacement(value?.exterior, 'Canyon'),
    interior: projectPlacement(value?.interior, 'Chamber')
  };
}

export function createWorkspaceProject({ project, placements, activeSpace = 'map', reflectors, automaticReflectors, structures = [], globalReflectionLevelDb, globalMaterial, settings, echoFieldEnabled, mapView, background = null, terrainSpace = null, savedAt = new Date().toISOString() }) {
  const manual = reflectorList(reflectors, 'Project reflectors');
  const automatic = reflectorList(automaticReflectors, 'Echo field reflectors');
  if (new Set([...manual, ...automatic].map(reflector => reflector.id)).size !== manual.length + automatic.length) throw new Error('All project reflector ids must be unique.');
  const mapPlacement = projectPlacement(placements?.map, 'Map space');
  const terrainPlacements = terrainSpace ? projectTerrainPlacements(placements?.terrain, mapPlacement) : null;
  return {
    format: WORKSPACE_PROJECT_FORMAT,
    project: { id: project.id, name: project.name, createdAt: project.createdAt, savedAt },
    background: projectBackground(background),
    mapView,
    activeSpace: activeSpace === 'terrain' && terrainSpace ? 'terrain' : 'map',
    geometry: { placements: { map: mapPlacement, terrain: terrainPlacements }, reflectors: manual, echoFieldReflectors: automatic, structures: structureList(structures) },
    levels: { globalReflectionLevelDb, globalMaterial },
    monitor: { heading: settings.heading, arrivalsOnly: settings.arrivalsOnly, panningMode: settings.panningMode, playbackMode: settings.playbackMode },
    echoField: { enabled: echoFieldEnabled, radiusMetres: settings.echoFieldRadiusMetres },
    terrainSpace: terrainSpace ? serializeTerrainSpace(terrainSpace) : null,
    settings: settings.echoField
  };
}

export function parseWorkspaceProject(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('The selected file is not valid JSON.'); }
  if (value?.format !== WORKSPACE_PROJECT_FORMAT) throw new Error('The selected file is not an Echotect project.');
  const geometry = value.geometry ?? {};
  const reflectors = reflectorList(geometry.reflectors, 'Project reflectors');
  const automaticReflectors = reflectorList(geometry.echoFieldReflectors, 'Echo field reflectors');
  const structures = structureList(geometry.structures ?? []);
  const allIds = [...reflectors, ...automaticReflectors].map(reflector => reflector.id);
  if (new Set(allIds).size !== allIds.length) throw new Error('All project reflector ids must be unique.');
  const globalMaterial = materialValues.has(value.levels?.globalMaterial) && value.levels.globalMaterial !== 'inherit' ? value.levels.globalMaterial : 'generic';
  const heading = boundedValue(value.monitor?.heading, { minimum: 0, maximum: 359, fallback: 0 });
  const radiusMetres = Math.max(10, Number.isFinite(value.echoField?.radiusMetres) ? value.echoField.radiusMetres : 100);
  const terrainSpace = parseTerrainSpace(value.terrainSpace ?? null);
  const mapPlacement = projectPlacement(geometry.placements?.map, 'Map space');
  const terrainPlacements = terrainSpace ? projectTerrainPlacements(geometry.placements?.terrain, mapPlacement) : null;
  const mapView = isValidCoordinate(value.mapView) && Number.isFinite(value.mapView.zoom)
    ? { latitude: value.mapView.latitude, longitude: value.mapView.longitude, zoom: Math.max(0, Math.min(24, value.mapView.zoom)) }
    : { ...mapPlacement.listener, zoom: 15 };
  return {
    project: {
      id: typeof value.project?.id === 'string' && value.project.id ? value.project.id : crypto.randomUUID(),
      name: typeof value.project?.name === 'string' && value.project.name.trim() ? value.project.name.trim() : DEFAULT_PROJECT_NAME,
      createdAt: typeof value.project?.createdAt === 'string' ? value.project.createdAt : new Date().toISOString()
    },
    placements: { map: mapPlacement, terrain: terrainPlacements },
    activeSpace: value.activeSpace === 'terrain' && terrainSpace ? 'terrain' : 'map',
    reflectors,
    automaticReflectors,
    structures,
    globalReflectionLevelDb: boundedValue(value.levels?.globalReflectionLevelDb, REFLECTION_LEVEL_RANGE),
    globalMaterial,
    settings: {
      heading,
      arrivalsOnly: Boolean(value.monitor?.arrivalsOnly),
      panningMode: value.monitor?.panningMode === 'spatial-stereo' ? 'spatial-stereo' : 'hrtf-live',
      playbackMode: value.monitor?.playbackMode === 'rendered' ? 'rendered' : 'live',
      echoFieldRadiusMetres: radiusMetres,
      echoField: normalizeEchoFieldSettings(value.settings)
    },
    echoFieldEnabled: Boolean(value.echoField?.enabled),
    background: projectBackground(value.background),
    terrainSpace,
    mapView
  };
}
