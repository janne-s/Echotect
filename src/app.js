import { createDirectArrivalEvent, createEarlyArrivalEvents, monitorArrivalPlan } from './arrivals.js';
import { SOURCE_ONSET_GAIN } from './audio-model.js';
import { DEFAULT_ECHO_FIELD_SETTINGS, ECHO_FIELD_SETTINGS, normalizeEchoFieldSettings } from './echo-field-settings.js';
import { buildingHeightMetres, edgeKey, reflectionField, reflectorVisibilityGraph, wallReflectionCandidate } from './echo-geometry.js';
import { exportFrameLayout } from './export-layout.js';
import { directSoundMetrics, distanceMetres, isValidCoordinate, metresPerDegreeLatitude, metresPerDegreeLongitude, parseCoordinates, reflectionMetrics, soundSpeedMetresPerSecond } from './geo.js';
import { IMAGE_OPACITY_RANGE, IMAGE_WIDTH_RANGE, imageCoordinates, transformImageEdge, transformImagePoint } from './image-background.js';
import { effectiveMaterial, MATERIAL_LABELS, normalizeFacadeMaterial } from './materials.js';
import { addStereo, renderExportAudio, resampleToMono } from './offline-export.js';
import { createProjectManifest, validateProjectManifest } from './project-manifest.js';
import { boundedValue } from './range.js';
import { hrtfPosition } from './spatial.js';
import { createRectangleVertices, insertVertex, moveEdgeVertices, pointInStructureSpace, removeVertex, structureRing, structureVertices, structureWalls, validStructure } from './structures.js';
import { createWorkspaceProject, DEFAULT_MAP_PLACEMENT, DEFAULT_PROJECT_NAME, MAP_HEIGHT_RANGE, parseWorkspaceProject, placementHeights, REFLECTION_LEVEL_RANGE, reflectorHeight } from './workspace-project.js';
import { captureTerrain, MAXIMUM_CAPTURE_EXTENT_METRES, MINIMUM_CAPTURE_EXTENT_METRES, TERRAIN_PROVIDER, validCaptureBounds } from './terrain-tiles.js';
import { EXTERIOR_HEIGHT_RANGE, floorRange, GROUND_REFLECTION_RANGE, normalizeTerrainSpace, parseTerrainSpace, placePoint, scaleTerrainField, sectionProfile, segmentClear, serializeTerrainSpace, tallestCavityPoint, TERRAIN_SCALE_RANGE, terrainDistanceMetres, terrainFrame, terrainHeightMetres } from './terrain-space.js';
import { captureSpaceScene, DEFAULT_SPACE_VIEW, drawSection, drawSpace, paintSpacePulses, zoomSpaceView } from './space-view.js';
import { floorOutlineGeoJson, footprintCoordinates, footprintGeoJson, hillshadeDataUrl } from './terrain-view.js';
import { encodeFloat32Wav, wavByteLength, WAV_SAMPLE_RATE } from './wav.js';
import { unzipStored, zipStore } from './zip.js';
import { readHandoffMessage, TECT_MESSAGES } from './handoff.js';
import { handoffAirMetres, handoffPlacement, packagedHandoffs } from './tect-receive.js';

const OVERTURE_BUILDINGS_URL = 'pmtiles://https://data.source.coop/cholmes/overture/overture-buildings.pmtiles';
const ACCENT_COLOR = '#ff4fae';
const BUILDING_LAYER_IDS = ['overture-building-fill', 'overture-building-line'];
const MAP_VIEW_STORAGE_KEY = 'echotect:map-view:v1';
const BASEMAP_STORAGE_KEY = 'echotect:terrain-basemap:v1';
const WORKSPACE_STORAGE_KEY = 'echotect:workspace:v4';
let resetting = false;
window.addEventListener('app-reset', () => { resetting = true; });
const materialValues = new Set(Object.keys(MATERIAL_LABELS));
const DEFAULT_HANDCLAP_DURATION_SECONDS = 0.2003125;
const DEFAULT_MAP_VIEW = Object.freeze({ longitude: 24.939, latitude: 60.1706, zoom: 15 });
const MAXIMUM_ZOOM = 24;
const HEADING_RANGE = Object.freeze({ minimum: 0, maximum: 359, fallback: 0 });
const MINIMUM_ECHO_FIELD_RADIUS_METRES = 10;
const ECHO_FIELD_CIRCLE_POINTS = 64;
const STEM_FILE_COUNT = 3;
const DEFAULT_SOUND_NAME = 'handclap.wav';
const DEFAULT_ECHO_FIELD_RADIUS_METRES = 100;
const WORKSPACE_SAVE_DELAY_MS = 400;
const MAXIMUM_BACKGROUND_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_SOURCE_ID = 'echotect-background-image';
const IMAGE_LAYER_ID = 'echotect-background-image';
const IMAGE_SCALE_SOURCE_ID = 'echotect-image-scale';
const STRUCTURE_VERTEX_HIT_RADIUS_PIXELS = 12;
const DEFAULT_STRUCTURE_SIZE_METRES = 20;
const MINIMUM_INITIAL_STRUCTURE_SIZE_METRES = .5;
const OSM_TILE_URLS = ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'];
const RELIEF_TILE_URLS = ['https://tile.opentopomap.org/{z}/{x}/{y}.png'];
const BASEMAP_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Optional relief: DEM SRTM/Sonny, style © <a href="https://opentopomap.org/">OpenTopoMap</a> (<a href="https://github.com/der-stefan/OpenTopoMap/blob/master/LICENCE">CC BY-SA</a>)';
const BASEMAP_RASTER_PAINT = Object.freeze({
  'raster-saturation': -1,
  'raster-contrast': .22,
  'raster-brightness-min': .02,
  'raster-brightness-max': .46,
  'raster-fade-duration': 0
});
const MAXIMUM_REFLECTION_PULSES = 4800;
const MAXIMUM_VISUALIZED_PATHS = 800;
const MAXIMUM_LATE_REFLECTION_PULSES = 4000;
const AUDIO_RECOVERY_OPERATION_TIMEOUT_MS = 1200;
const AUDIO_RECOVERY_CLOCK_TEST_MS = 250;
const AUDIO_RECOVERY_MINIMUM_CLOCK_ADVANCE_SECONDS = .05;
const TERRAIN_IMAGE_SOURCE_ID = 'terrain-hillshade';
const TERRAIN_BUILD_DELAY_MS = 80;
const TERRAIN_HILLSHADE_OPACITY = .8;

const validEdge = edge => Array.isArray(edge) && edge.length === 2
  && edge.every(point => Array.isArray(point) && point.length >= 2 && point.every(Number.isFinite));

function storedMapView() {
  try {
    const view = JSON.parse(localStorage.getItem(MAP_VIEW_STORAGE_KEY));
    if (isValidCoordinate(view) && Number.isFinite(view.zoom) && view.zoom >= 0 && view.zoom <= MAXIMUM_ZOOM) return view;
  } catch {
  }
  return { ...DEFAULT_MAP_VIEW };
}

function storedBasemap() {
  try {
    return localStorage.getItem(BASEMAP_STORAGE_KEY) === 'relief' ? 'relief' : 'map';
  } catch {
    return 'map';
  }
}

const newProject = () => ({ id: crypto.randomUUID(), name: DEFAULT_PROJECT_NAME, createdAt: new Date().toISOString() });

function defaultWorkspace() {
  return {
    project: newProject(),
    activeSpace: 'map',
    mapPlacement: copiedPlacement(DEFAULT_MAP_PLACEMENT),
    terrainPlacements: null,
    reflectors: [{ id: crypto.randomUUID(), latitude: 60.1721, longitude: 24.9384, levelDb: REFLECTION_LEVEL_RANGE.fallback, material: 'inherit' }],
    structures: [],
    terrainSpace: null,
    echoFieldEnabled: false,
    automaticReflectors: [],
    globalReflectionLevelDb: REFLECTION_LEVEL_RANGE.fallback,
    globalMaterial: 'generic',
    settings: {
      heading: HEADING_RANGE.fallback,
      arrivalsOnly: false,
      panningMode: 'hrtf-live',
      playbackMode: 'live',
      echoFieldRadiusMetres: DEFAULT_ECHO_FIELD_RADIUS_METRES,
      echoField: { ...DEFAULT_ECHO_FIELD_SETTINGS }
    }
  };
}

function storedTerrainSpace(value) {
  try {
    return parseTerrainSpace(value ?? null);
  } catch {
    return null;
  }
}

function storedPlacement(value) {
  if (!isValidCoordinate(value?.source) || !isValidCoordinate(value?.listener)) return null;
  return {
    source: { latitude: value.source.latitude, longitude: value.source.longitude },
    listener: { latitude: value.listener.latitude, longitude: value.listener.longitude },
    pointsLinked: Boolean(value.pointsLinked),
    heightsMetres: placementHeights(value.heightsMetres)
  };
}

function copiedPlacement(value) {
  return {
    source: { ...value.source },
    listener: { ...value.listener },
    pointsLinked: value.pointsLinked,
    heightsMetres: placementHeights(value.heightsMetres)
  };
}

function liftedMapPoints() {
  const { source, listener, heightsMetres } = state.mapPlacement;
  return { source: { ...source, heightMetres: heightsMetres.source }, listener: { ...listener, heightMetres: heightsMetres.listener } };
}

function terrainPlacementsFrom(value) {
  return {
    exterior: copiedPlacement(value),
    interior: copiedPlacement(value)
  };
}

function storedTerrainPlacements(value) {
  const exterior = storedPlacement(value?.exterior);
  const interior = storedPlacement(value?.interior);
  return exterior && interior ? { exterior, interior } : null;
}

function storedReflectors(values) {
  if (!Array.isArray(values)) return [];
  return values.filter(isValidCoordinate).map(reflector => ({
    id: typeof reflector.id === 'string' ? reflector.id : crypto.randomUUID(),
    latitude: reflector.latitude,
    longitude: reflector.longitude,
    levelDb: boundedValue(reflector.levelDb, REFLECTION_LEVEL_RANGE),
    material: materialValues.has(reflector.material) ? reflector.material : 'inherit',
    ...reflectorHeight(reflector),
    ...(validEdge(reflector.buildingEdge) ? { buildingEdge: reflector.buildingEdge } : {}),
    ...(typeof reflector.buildingId === 'string' || typeof reflector.buildingId === 'number' ? { buildingId: reflector.buildingId } : {}),
    ...(typeof reflector.facadeMaterial === 'string' ? { facadeMaterial: reflector.facadeMaterial } : {}),
    ...(['specular', 'diffuse'].includes(reflector.reflectionKind) ? { reflectionKind: reflector.reflectionKind } : {}),
    ...(Array.isArray(reflector.visibleReflectorIds) ? { visibleReflectorIds: reflector.visibleReflectorIds.filter(id => typeof id === 'string') } : {})
  }));
}

function storedWorkspace() {
  try {
    const saved = JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY));
    if (!saved || typeof saved !== 'object') return null;
    const mapPlacement = storedPlacement(saved.mapPlacement) ?? copiedPlacement(DEFAULT_MAP_PLACEMENT);
    const terrainSpace = storedTerrainSpace(saved.terrainSpace);
    const terrainPlacements = terrainSpace ? storedTerrainPlacements(saved.terrainPlacements) ?? terrainPlacementsFrom(mapPlacement) : null;
    return {
      project: typeof saved.project?.id === 'string' && typeof saved.project?.name === 'string' && typeof saved.project?.createdAt === 'string'
        ? saved.project : newProject(),
      activeSpace: saved.activeSpace === 'terrain' && terrainSpace ? 'terrain' : 'map',
      mapPlacement,
      terrainPlacements,
      reflectors: storedReflectors(saved.reflectors),
      structures: Array.isArray(saved.structures) ? saved.structures.filter(validStructure) : [],
      terrainSpace,
      echoFieldEnabled: Boolean(saved.echoFieldEnabled),
      automaticReflectors: storedReflectors(saved.automaticReflectors),
      globalReflectionLevelDb: boundedValue(saved.globalReflectionLevelDb, REFLECTION_LEVEL_RANGE),
      globalMaterial: materialValues.has(saved.globalMaterial) && saved.globalMaterial !== 'inherit' ? saved.globalMaterial : 'generic',
      settings: {
        heading: boundedValue(saved.settings?.heading, HEADING_RANGE),
        arrivalsOnly: Boolean(saved.settings?.arrivalsOnly),
        panningMode: saved.settings?.panningMode === 'spatial-stereo' ? 'spatial-stereo' : 'hrtf-live',
        playbackMode: saved.settings?.playbackMode === 'rendered' ? 'rendered' : 'live',
        echoFieldRadiusMetres: Math.max(MINIMUM_ECHO_FIELD_RADIUS_METRES, Number.isFinite(saved.settings?.echoFieldRadiusMetres) ? saved.settings.echoFieldRadiusMetres : DEFAULT_ECHO_FIELD_RADIUS_METRES),
        echoField: normalizeEchoFieldSettings(saved.settings?.echoField)
      }
    };
  } catch {
    return null;
  }
}

const state = storedWorkspace() ?? defaultWorkspace();
state.settings.echoField = { ...state.settings.echoField, sourceAirMetres: 0 };
state.buildingsVisible = false;
let activeTool = null;
let audioContext;
let importedAudioBuffer = null;
let importedAudioName = null;
let importedAudioAirMetres = 0;
let defaultHandclapBuffer = null;
let audioSourceRevision = 0;
let monitorRenderCache = null;
let renderedPlayback = null;
let renderingPlayback = false;
let activeRender = null;
let activePlayback = null;
let playbackProgressTimer = null;
let reflectionPulseAnimationFrame = null;
let lastSearchAt = 0;
let hoveredBuildingEdge = null;
let automaticReflectors = state.automaticReflectors;
let echoFieldEnabled = state.echoFieldEnabled;
let echoFieldUsesSavedReflectors = echoFieldEnabled && automaticReflectors.length > 0;
let echoFieldHandle = null;
let echoFieldUpdateTimer = null;
let imageBackground = null;
let activeImagePanel = null;
let imageScalePoints = [];
let imageScaleCursor = null;
let renderedImageDataUrl = null;
let selectedStructureId = null;
let structurePanelOpen = false;
const structureMarkers = [];
let structureAreaDrag = null;
let structureEdgeDrag = null;
let suppressStructureEdgeClick = false;
let terrainField = null;
let canonicalTerrainField = null;
let terrainWorker = null;
let terrainRevision = 0;
let terrainBuildInFlight = false;
let terrainBuildQueued = false;
let terrainBuildTimer = null;
let terrainDrawArmed = false;
let terrainDraft = null;
let terrainPreview = null;
let terrainMove = null;
let terrainLoading = null;
let renderedTerrainImage = null;
let cachedTerrainFrame = null;
let storedHeightfield = null;
let basemap = storedBasemap();
const terrainHandles = [];

const protocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);
const initialMapView = storedMapView();

const map = new maplibregl.Map({
  container: 'map',
  attributionControl: false,
  center: [initialMapView.longitude, initialMapView.latitude],
  zoom: initialMapView.zoom,
  style: {
    version: 8,
    sources: {
      osm: {
        type: 'raster', tiles: OSM_TILE_URLS, tileSize: 256,
        attribution: BASEMAP_ATTRIBUTION
      },
      relief: {
        type: 'raster', tiles: RELIEF_TILE_URLS, tileSize: 256, maxzoom: 17,
        attribution: BASEMAP_ATTRIBUTION
      }
    },
    layers: [
      { id: 'osm', type: 'raster', source: 'osm', paint: { ...BASEMAP_RASTER_PAINT } },
      { id: 'relief', type: 'raster', source: 'relief', layout: { visibility: 'none' }, paint: { ...BASEMAP_RASTER_PAINT } }
    ]
  }
});
const mapContainer = map.getContainer();
mapContainer.classList.add('map-attribution-initializing');
map.addControl(new maplibregl.AttributionControl({ compact: true }));

function collapseInitialMapAttribution() {
  const attributionDetails = mapContainer.querySelector('details.maplibregl-ctrl-attrib');
  attributionDetails?.classList.remove('maplibregl-compact-show');
  attributionDetails?.removeAttribute('open');
}

// MapLibre 5.24 expands compact attribution again when async source metadata arrives.
map.once('load', () => {
  collapseInitialMapAttribution();
  mapContainer.classList.remove('map-attribution-initializing');
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left');

function createBasemapToggle() {
  const button = document.createElement('button');
  button.className = 'basemap-button';
  button.type = 'button';
  button.innerHTML = '<i class="fa-solid fa-mountain" aria-hidden="true"></i>';
  button.addEventListener('click', () => {
    basemap = basemap === 'relief' ? 'map' : 'relief';
    try { localStorage.setItem(BASEMAP_STORAGE_KEY, basemap); } catch { /* The view preference is optional. */ }
    syncBasemap();
  });
  mapContainer.querySelector('.maplibregl-ctrl-bottom-left .maplibregl-ctrl-group')?.append(button);
  return {
    sync() {
      const relief = basemap === 'relief';
      button.setAttribute('aria-pressed', String(relief));
      button.setAttribute('aria-label', relief ? 'Use street map' : 'Use relief map');
      button.title = relief ? 'Relief map · switch to street map' : 'Street map · switch to relief map';
    }
  };
}

const basemapToggle = createBasemapToggle();
basemapToggle.sync();
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }));

map.on('moveend', () => {
  if (resetting) return;
  const center = map.getCenter();
  try {
    localStorage.setItem(MAP_VIEW_STORAGE_KEY, JSON.stringify({
      longitude: center.lng,
      latitude: center.lat,
      zoom: map.getZoom()
    }));
  } catch {
  }
});

const markers = new Map();
const $ = selector => document.querySelector(selector);
const coordinateText = point => `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`;
const pointFromLngLat = lngLat => ({ latitude: lngLat.lat, longitude: lngLat.lng });

let workspaceSaveTimer = null;

function scheduleSave() {
  syncPlayButton();
  clearTimeout(workspaceSaveTimer);
  workspaceSaveTimer = setTimeout(saveWorkspace, WORKSPACE_SAVE_DELAY_MS);
}

function saveWorkspaceNow() {
  clearTimeout(workspaceSaveTimer);
  saveWorkspace();
}

window.addEventListener('pagehide', saveWorkspaceNow);

function storableTerrainSpace() {
  if (!state.terrainSpace) return null;
  if (storedHeightfield?.capture !== state.terrainSpace.capture) {
    storedHeightfield = { capture: state.terrainSpace.capture, heightfield: serializeTerrainSpace(state.terrainSpace).heightfield };
  }
  return { ...serializeTerrainSpace(state.terrainSpace, { includeHeightfield: false }), heightfield: storedHeightfield.heightfield };
}

function saveWorkspace() {
  if (resetting) return;
  try {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({
      project: state.project,
      activeSpace: state.activeSpace,
      mapPlacement: state.mapPlacement,
      terrainPlacements: state.terrainPlacements,
      reflectors: state.reflectors,
      automaticReflectors,
      echoFieldEnabled,
      structures: state.structures,
      terrainSpace: storableTerrainSpace(),
      globalReflectionLevelDb: state.globalReflectionLevelDb,
      globalMaterial: state.globalMaterial,
      settings: state.settings
    }));
  } catch {
  }
}

function syncWorkspaceControls() {
  Object.assign($('#global-level'), { min: REFLECTION_LEVEL_RANGE.minimum, max: REFLECTION_LEVEL_RANGE.maximum, value: state.globalReflectionLevelDb });
  $('#global-level-value').textContent = `${state.globalReflectionLevelDb} dB`;
  $('#global-material').value = state.globalMaterial;
  Object.assign($('#listener-heading'), { min: HEADING_RANGE.minimum, max: HEADING_RANGE.maximum, value: state.settings.heading });
  $('#heading-value').textContent = `${state.settings.heading}°`;
  $('#heading-arrow').style.transform = `rotate(${state.settings.heading}deg)`;
  $('#arrivals-only').checked = state.settings.arrivalsOnly;
  $('#panning-mode').value = state.settings.panningMode;
  updateDirectPathMetrics();
  syncPlayButton();
}

document.querySelectorAll('[data-material-options]').forEach(select => {
  const values = Object.keys(MATERIAL_LABELS).filter(value => value !== 'inherit' || select.dataset.materialOptions === 'inherit');
  select.replaceChildren(...values.map(value => new Option(MATERIAL_LABELS[value], value)));
});

function markerElement(type, label = '') {
  const element = document.createElement('div');
  element.className = `marker marker-${type}`;
  if (label) {
    element.textContent = label;
    element.setAttribute('aria-label', `Reflector ${label}`);
    element.title = `Reflector ${label}`;
  }
  return element;
}

function createMarker(id, type, point, onMove, label) {
  const marker = new maplibregl.Marker({ element: markerElement(type, label), draggable: true })
    .setLngLat([point.longitude, point.latitude]).addTo(map);
  const updatePosition = () => onMove(pointFromLngLat(marker.getLngLat()));
  marker.on('drag', updatePosition);
  marker.on('dragend', () => { updatePosition(); render(); });
  markers.set(id, marker);
}

function releaseSavedEchoField() {
  echoFieldUsesSavedReflectors = false;
}

function syncMarkers() {
  markers.forEach(marker => marker.remove());
  markers.clear();
  const placement = activePlacement();
  if (placement.pointsLinked) {
    createMarker('combined', 'combined', placement.source, point => {
      releaseSavedEchoField();
      placement.source = point;
      placement.listener = { ...point };
      renderGeometry();
    });
  } else {
    createMarker('source', 'source', placement.source, point => { releaseSavedEchoField(); placement.source = point; renderGeometry(); });
    createMarker('listener', 'listener', placement.listener, point => { releaseSavedEchoField(); placement.listener = point; renderGeometry(); });
  }
  visibleManualReflectors().forEach((reflector, index) => createMarker(reflector.id, 'reflector', reflector, point => {
    Object.assign(reflector, point);
    delete reflector.buildingEdge;
    delete reflector.buildingId;
    delete reflector.facadeMaterial;
    renderGeometry();
  }, String(index + 1)));
  syncMarkerHeights();
}

const formatHeight = metres => `${metres < 10 ? metres.toFixed(1) : Math.round(metres)} m`;

const mapHeightsLevel = () => Object.values(state.mapPlacement.heightsMetres).every(height => height === MAP_HEIGHT_RANGE.fallback);

function syncMarkerHeights() {
  syncMapHeights();
  const placement = terrainActive() ? propagation() : mapHeightsLevel() ? null : { ...liftedMapPoints(), map: true };
  [['source', 'source'], ['listener', 'listener'], ['combined', 'listener']].forEach(([id, role]) => {
    const element = markers.get(id)?.getElement();
    if (!element) return;
    let label = element.querySelector('.marker-height');
    if (!placement) { label?.remove(); element.classList.remove('marker-invalid'); return; }
    if (!label) {
      label = document.createElement('span');
      label.className = 'marker-height';
      element.append(label);
    }
    const placed = placement[role];
    label.textContent = formatHeight(placed.heightMetres);
    element.classList.toggle('marker-invalid', !placement.map && !placed.valid);
  });
}

function syncMapHeights() {
  $('#map-heights').hidden = terrainActive();
  ['source', 'listener'].forEach(role => {
    const height = state.mapPlacement.heightsMetres[role];
    const input = $(`#map-${role}-height`);
    if (document.activeElement !== input) input.value = geometricPosition(height, MAP_HEIGHT_RANGE.minimum, MAP_HEIGHT_RANGE.maximum);
    $(`#map-${role}-height-value`).textContent = formatHeight(height);
  });
}

['source', 'listener'].forEach(role => {
  $(`#map-${role}-height`).addEventListener('input', event => {
    state.mapPlacement.heightsMetres = {
      ...state.mapPlacement.heightsMetres,
      [role]: geometricValue(Number(event.currentTarget.value), MAP_HEIGHT_RANGE.minimum, MAP_HEIGHT_RANGE.maximum)
    };
    renderGeometry();
  });
});

function activeTerrainPlacement() { return state.terrainPlacements?.[state.terrainSpace?.mode] ?? null; }
function terrainAvailable() { return Boolean(state.terrainSpace && activeTerrainPlacement()); }
function terrainActive() { return state.activeSpace === 'terrain' && terrainAvailable(); }
function activePlacement() { return terrainActive() ? activeTerrainPlacement() : state.mapPlacement; }

function syncBasemap() {
  const relief = basemap === 'relief';
  if (map.getLayer('osm')) map.setLayoutProperty('osm', 'visibility', relief ? 'none' : 'visible');
  if (map.getLayer('relief')) map.setLayoutProperty('relief', 'visibility', relief ? 'visible' : 'none');
  basemapToggle.sync();
  collapseInitialMapAttribution();
}
const audibleReflectors = () => terrainActive()
  ? terrainField?.valid ? terrainField.reflectors : []
  : [...state.reflectors, ...automaticReflectors];
const hasEchoFieldWalls = () => state.buildingsVisible || state.structures.length > 0;
const visibleManualReflectors = () => terrainActive() ? [] : state.reflectors;

function setEchoFieldButtonDisabled(disabled) {
  $('#echo-field-button').disabled = disabled || terrainActive();
}

function activeTerrainFrame() {
  if (!terrainActive()) return null;
  if (cachedTerrainFrame?.space !== state.terrainSpace) cachedTerrainFrame = { space: state.terrainSpace, frame: terrainFrame(state.terrainSpace) };
  return cachedTerrainFrame.frame;
}

function propagation() {
  const placement = activePlacement();
  const frame = activeTerrainFrame();
  if (!frame) return { ...liftedMapPoints(), distanceMetres, directOccluded: false, valid: true };
  const source = placePoint(frame, placement.source, terrainHeightMetres(state.terrainSpace, 'source'));
  const listener = placePoint(frame, placement.listener, terrainHeightMetres(state.terrainSpace, 'listener'));
  const valid = source.valid && listener.valid;
  return {
    source, listener, distanceMetres: terrainDistanceMetres, valid,
    directOccluded: valid && !segmentClear(frame, source.positionMetres, listener.positionMetres)
  };
}

const renderSettings = () => terrainActive() ? { ...state.settings.echoField, buildingOcclusion: true } : state.settings.echoField;

const selectedStructure = () => state.structures.find(structure => structure.id === selectedStructureId) ?? null;

function structuresGeoJson() {
  return {
    type: 'FeatureCollection',
    features: state.structures.map(structure => ({
      type: 'Feature',
      properties: { id: structure.id, selected: structure.id === selectedStructureId },
      geometry: { type: 'Polygon', coordinates: [structureRing(structure)] }
    }))
  };
}

function structureEdgesGeoJson() {
  return {
    type: 'FeatureCollection',
    features: state.structures.flatMap(structure => {
      const ring = structureRing(structure);
      return ring.slice(1).map((point, index) => ({
        type: 'Feature', properties: { id: structure.id, edgeIndex: index },
        geometry: { type: 'LineString', coordinates: [ring[index], point] }
      }));
    })
  };
}

function isNearStructureVertex(screenPoint, structure) {
  const radiusSquared = STRUCTURE_VERTEX_HIT_RADIUS_PIXELS ** 2;
  return structureVertices(structure).some(vertex => {
    const projected = map.project([vertex.longitude, vertex.latitude]);
    return (projected.x - screenPoint.x) ** 2 + (projected.y - screenPoint.y) ** 2 <= radiusSquared;
  });
}

function clearStructureMarkers() {
  structureMarkers.splice(0).forEach(marker => marker.remove());
}

function positionStructureMarkers(structure, skippedMarker = null) {
  const points = structureVertices(structure);
  if (structureMarkers.length !== points.length) return;
  structureMarkers.forEach((marker, index) => {
    if (marker !== skippedMarker) marker.setLngLat([points[index].longitude, points[index].latitude]);
  });
}

function structureHandle(className, label) {
  const element = document.createElement('div');
  element.className = `structure-handle ${className}`;
  element.setAttribute('aria-label', label);
  element.title = label;
  return element;
}

function syncStructurePanel() {
  const structure = selectedStructure();
  $('#image-editor').hidden = false;
  $('#structure-panel').hidden = !structurePanelOpen;
  $('#structure-menu-button').setAttribute('aria-pressed', String(structurePanelOpen));
  $('#delete-structure').disabled = !structure;
  if (!structure) return;
  $('#structure-material').value = structure.material;
}

function commitStructureGeometry() {
  releaseSavedEchoField();
  map.getSource('structures')?.setData(structuresGeoJson());
  map.getSource('structure-edges')?.setData(structureEdgesGeoJson());
  syncStructurePanel();
  scheduleEchoFieldUpdate();
  scheduleSave();
}

function syncStructureGeometry() {
  map.getSource('structures')?.setData(structuresGeoJson());
  clearStructureMarkers();
  const structure = selectedStructure();
  syncStructurePanel();
  if (!structure) return;
  structureVertices(structure).forEach((vertex, index) => {
    const element = structureHandle('structure-handle-corner', `Move polygon vertex ${index + 1}`);
    const marker = new maplibregl.Marker({ element, draggable: true })
      .setLngLat([vertex.longitude, vertex.latitude]).addTo(map);
    marker.on('drag', () => {
      structure.verticesMetres[index] = pointInStructureSpace(structure, pointFromLngLat(marker.getLngLat()));
      positionStructureMarkers(structure, marker);
      commitStructureGeometry();
    });
    marker.on('dragend', () => { syncStructureGeometry(); commitStructureGeometry(); });
    element.addEventListener('dblclick', event => {
      event.preventDefault();
      event.stopPropagation();
      structure.verticesMetres = removeVertex(structure.verticesMetres, index);
      syncStructureGeometry();
      commitStructureGeometry();
    });
    structureMarkers.push(marker);
  });
}

function selectStructure(id) {
  selectedStructureId = state.structures.some(structure => structure.id === id) ? id : null;
  structurePanelOpen = Boolean(selectedStructureId);
  syncStructureGeometry();
}

function deleteSelectedStructure() {
  if (!selectedStructure()) return;
  state.structures = state.structures.filter(structure => structure.id !== selectedStructureId);
  selectedStructureId = null;
  structurePanelOpen = true;
  if (!hasEchoFieldWalls() && echoFieldEnabled) setEchoFieldEnabled(false);
  setEchoFieldButtonDisabled(!hasEchoFieldWalls());
  syncStructureGeometry();
  commitStructureGeometry();
}

function routeGeoJson() {
  const placement = activePlacement();
  return {
    type: 'FeatureCollection',
    features: audibleReflectors().map(reflector => ({
      type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [
        [placement.source.longitude, placement.source.latitude],
        [reflector.longitude, reflector.latitude],
        [placement.listener.longitude, placement.listener.latitude]
      ] }
    }))
  };
}

function directRouteGeoJson() {
  const placement = activePlacement();
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: [
      [placement.source.longitude, placement.source.latitude],
      [placement.listener.longitude, placement.listener.latitude]
    ] }
  };
}

function buildingEdgesGeoJson() {
  return {
    type: 'FeatureCollection',
    features: audibleReflectors().filter(reflector => reflector.buildingEdge).map(reflector => ({
      type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: reflector.buildingEdge }
    }))
  };
}

function hoveredBuildingEdgeGeoJson() {
  return hoveredBuildingEdge ? {
    type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: hoveredBuildingEdge }
  } : { type: 'FeatureCollection', features: [] };
}

function clearBuildingHover() {
  hoveredBuildingEdge = null;
  const source = map.getSource('hovered-building-edge');
  if (source) source.setData(hoveredBuildingEdgeGeoJson());
  map.getCanvas().style.cursor = '';
}

function circleGeoJson() {
  if (!echoFieldEnabled || terrainActive()) return { type: 'FeatureCollection', features: [] };
  const listener = state.mapPlacement.listener;
  const eastScale = metresPerDegreeLongitude(listener.latitude);
  const coordinates = Array.from({ length: ECHO_FIELD_CIRCLE_POINTS + 1 }, (_, index) => {
    const angle = index / ECHO_FIELD_CIRCLE_POINTS * Math.PI * 2;
    return [
      listener.longitude + Math.sin(angle) * state.settings.echoFieldRadiusMetres / eastScale,
      listener.latitude + Math.cos(angle) * state.settings.echoFieldRadiusMetres / metresPerDegreeLatitude()
    ];
  });
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coordinates] } };
}

function echoFieldHandlePoint() {
  const listener = state.mapPlacement.listener;
  return {
    latitude: listener.latitude,
    longitude: listener.longitude + state.settings.echoFieldRadiusMetres / metresPerDegreeLongitude(listener.latitude)
  };
}

function syncEchoFieldGeometry() {
  map.getSource('echo-field')?.setData(circleGeoJson());
  if (echoFieldEnabled && echoFieldHandle) {
    const point = echoFieldHandlePoint();
    echoFieldHandle.setLngLat([point.longitude, point.latitude]);
    echoFieldHandle.getElement().hidden = terrainActive();
  }
}

function syncRoutes() {
  const source = map.getSource('routes');
  if (source) source.setData(routeGeoJson());
  const directSource = map.getSource('direct-route');
  if (directSource) directSource.setData(directRouteGeoJson());
  const edgeSource = map.getSource('building-reflector-edges');
  if (edgeSource) edgeSource.setData(buildingEdgesGeoJson());
  map.getSource('structures')?.setData(structuresGeoJson());
  map.getSource('structure-edges')?.setData(structureEdgesGeoJson());
}

const EMPTY_GEOJSON = Object.freeze({ type: 'FeatureCollection', features: [] });
const TERRAIN_SIZE_MESSAGE = `The terrain rectangle must be ${MINIMUM_CAPTURE_EXTENT_METRES} m to ${MAXIMUM_CAPTURE_EXTENT_METRES / 1000} km across.`;
const TERRAIN_ATTRIBUTION = `<a href="${TERRAIN_PROVIDER.attributionUrl}">Terrain Tiles</a>: Mapzen, AWS Open Data`;

function removeTerrainLayers() {
  ['terrain-floor', 'terrain-outline', 'terrain-hit', TERRAIN_IMAGE_SOURCE_ID].forEach(id => { if (map.getLayer(id)) map.removeLayer(id); });
  ['terrain-floor', 'terrain-outline', TERRAIN_IMAGE_SOURCE_ID].forEach(id => { if (map.getSource(id)) map.removeSource(id); });
  renderedTerrainImage = null;
}

function syncTerrainLayers() {
  if (!map.getStyle() || !map.getLayer('direct-route')) return;
  const frame = activeTerrainFrame();
  if (!frame) { removeTerrainLayers(); return; }
  const imageKey = { capture: state.terrainSpace.capture, mode: frame.mode, floor: frame.floor };
  const image = map.getSource(TERRAIN_IMAGE_SOURCE_ID);
  const sameImage = renderedTerrainImage && Object.entries(imageKey).every(([key, value]) => renderedTerrainImage[key] === value);
  if (image && sameImage) image.setCoordinates(footprintCoordinates(frame));
  else {
    if (map.getLayer(TERRAIN_IMAGE_SOURCE_ID)) map.removeLayer(TERRAIN_IMAGE_SOURCE_ID);
    if (image) map.removeSource(TERRAIN_IMAGE_SOURCE_ID);
    map.addSource(TERRAIN_IMAGE_SOURCE_ID, { type: 'image', url: hillshadeDataUrl(frame), coordinates: footprintCoordinates(frame) });
    map.addLayer({
      id: TERRAIN_IMAGE_SOURCE_ID, type: 'raster', source: TERRAIN_IMAGE_SOURCE_ID,
      paint: { 'raster-opacity': TERRAIN_HILLSHADE_OPACITY, 'raster-fade-duration': 0 }
    }, map.getLayer('structures-fill') ? 'structures-fill' : 'direct-route');
    renderedTerrainImage = imageKey;
  }
  if (!map.getSource('terrain-outline')) {
    map.addSource('terrain-outline', { type: 'geojson', data: footprintGeoJson(frame), attribution: TERRAIN_ATTRIBUTION });
    map.addLayer({ id: 'terrain-hit', type: 'fill', source: 'terrain-outline', paint: { 'fill-color': ACCENT_COLOR, 'fill-opacity': 0 } }, 'direct-route');
    map.addLayer({ id: 'terrain-outline', type: 'line', source: 'terrain-outline', paint: { 'line-color': ACCENT_COLOR, 'line-width': 2, 'line-opacity': .9 } }, 'direct-route');
    map.addSource('terrain-floor', { type: 'geojson', data: floorOutlineGeoJson(frame) });
    map.addLayer({ id: 'terrain-floor', type: 'line', source: 'terrain-floor', paint: { 'line-color': ACCENT_COLOR, 'line-width': 1.5, 'line-opacity': .8, 'line-dasharray': [2, 2] } }, 'direct-route');
  } else {
    map.getSource('terrain-outline').setData(footprintGeoJson(frame));
    map.getSource('terrain-floor').setData(floorOutlineGeoJson(frame));
  }
}

const rectangleRing = (a, b) => [[a.longitude, a.latitude], [b.longitude, a.latitude], [b.longitude, b.latitude], [a.longitude, b.latitude], [a.longitude, a.latitude]];

function terrainDraftGeoJson() {
  const ring = terrainPreview ?? (terrainDraft ? rectangleRing(pointFromLngLat(terrainDraft.start), pointFromLngLat(terrainDraft.end)) : null);
  return ring ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ring } } : EMPTY_GEOJSON;
}

function setTerrainPreview(ring) {
  terrainPreview = ring;
  map.getSource('terrain-draft')?.setData(terrainDraftGeoJson());
}

const boundsBetween = (a, b) => ({
  west: Math.min(a.longitude, b.longitude), east: Math.max(a.longitude, b.longitude),
  south: Math.min(a.latitude, b.latitude), north: Math.max(a.latitude, b.latitude)
});

function clearTerrainHandles() {
  terrainHandles.splice(0).forEach(marker => marker.remove());
}

function syncTerrainHandles() {
  const frame = activeTerrainFrame();
  if (!frame) { clearTerrainHandles(); return; }
  const corners = frame.footprint();
  if (terrainHandles.length !== corners.length) {
    clearTerrainHandles();
    corners.forEach((corner, index) => {
      const element = document.createElement('div');
      element.className = 'terrain-handle';
      element.setAttribute('aria-label', 'Reshape terrain');
      element.title = 'Reshape terrain';
      const marker = new maplibregl.Marker({ element, draggable: true }).setLngLat([corner.longitude, corner.latitude]).addTo(map);
      marker.on('drag', () => {
        const current = activeTerrainFrame();
        if (current) setTerrainPreview(rectangleRing(pointFromLngLat(marker.getLngLat()), current.footprint()[(index + 2) % 4]));
      });
      marker.on('dragend', () => {
        const current = activeTerrainFrame();
        if (!current) return;
        const opposite = current.footprint()[(index + 2) % 4];
        const bounds = boundsBetween(pointFromLngLat(marker.getLngLat()), opposite);
        if (validCaptureBounds(bounds)) loadTerrain(bounds);
        else {
          setTerrainPreview(null);
          syncTerrainHandles();
          window.alert(TERRAIN_SIZE_MESSAGE);
        }
      });
      terrainHandles.push(marker);
    });
  }
  terrainHandles.forEach((marker, index) => marker.setLngLat([corners[index].longitude, corners[index].latitude]));
}

function syncTerrainControls() {
  const active = terrainActive();
  const available = terrainAvailable();
  const button = $('#terrain-button');
  const drawButton = $('#terrain-draw-button');
  button.setAttribute('aria-pressed', String(active || (!available && terrainDrawArmed)));
  const count = terrainField?.valid ? terrainField.reflectors.length : 0;
  button.textContent = active && count ? `Terrain · ${count}` : 'Terrain';
  button.title = active ? 'Return to map space' : available ? 'Open saved terrain space' : terrainDrawArmed ? 'Drag a rectangle on the map' : 'Draw a terrain rectangle';
  button.disabled = Boolean(imageBackground);
  $('#terrain-actions').classList.toggle('has-terrain', available);
  drawButton.hidden = !available;
  drawButton.disabled = Boolean(imageBackground || terrainLoading);
  drawButton.setAttribute('aria-pressed', String(available && terrainDrawArmed));
  drawButton.setAttribute('aria-label', terrainDrawArmed ? 'Cancel drawing new terrain' : 'Draw new terrain');
  drawButton.title = terrainDrawArmed ? 'Cancel drawing new terrain' : 'Draw new terrain';
  if (terrainLoading) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
  setEchoFieldButtonDisabled(!hasEchoFieldWalls());
  $('#image-background-button').disabled = active;
  $('#clear-reflectors').disabled = active;
  document.querySelectorAll('[data-tool="reflector"]').forEach(tool => { tool.disabled = active; });
  $('#settings-tab-terrain').disabled = !active;
}

function setTerrainDrawArmed(armed) {
  terrainDrawArmed = armed;
  if (armed) {
    activeTool = null;
    document.querySelectorAll('[data-tool]').forEach(tool => tool.classList.remove('active'));
    clearBuildingHover();
  }
  map.getCanvas().style.cursor = armed ? 'crosshair' : '';
  syncTerrainControls();
}

function syncTerrainResult() {
  scheduleSpaceDraw();
  syncRoutes();
  syncTerrainControls();
  syncPlayButton();
  $('#empty-reflections').hidden = audibleReflectors().length > 0 || terrainActive();
}

function createTerrainWorker() {
  const worker = new Worker(new URL('./terrain-worker.js', import.meta.url), { type: 'module' });
  worker.addEventListener('message', ({ data }) => {
    terrainBuildInFlight = false;
    if (data.revision === terrainRevision && state.terrainSpace) {
      if (data.error) console.error(data.error);
      canonicalTerrainField = data.error ? null : data.field;
      terrainField = canonicalTerrainField ? scaleTerrainField(canonicalTerrainField, state.terrainSpace.scale) : null;
      monitorRenderCache = null;
      invalidateRenderedPlayback();
      syncTerrainResult();
    }
    if (terrainBuildQueued) {
      terrainBuildQueued = false;
      requestTerrainBuild();
    }
  });
  worker.addEventListener('error', event => {
    terrainBuildInFlight = false;
    console.error(event.message);
    canonicalTerrainField = null;
    terrainField = null;
    monitorRenderCache = null;
    invalidateRenderedPlayback();
    syncTerrainResult();
    if (terrainBuildQueued) {
      terrainBuildQueued = false;
      requestTerrainBuild();
    }
  });
  return worker;
}

function requestTerrainBuild() {
  if (!terrainActive()) return;
  if (terrainBuildInFlight) { terrainBuildQueued = true; return; }
  terrainWorker ??= createTerrainWorker();
  terrainBuildInFlight = true;
  terrainRevision += 1;
  terrainWorker.postMessage({
    revision: terrainRevision, space: state.terrainSpace, source: activeTerrainPlacement().source, listener: activeTerrainPlacement().listener,
    globalReflectionLevelDb: state.globalReflectionLevelDb, maxSurfaces: state.settings.echoField.maxSurfaces,
    speedOfSound: soundSpeedMetresPerSecond(state.settings.echoField)
  });
}

function scheduleTerrainBuild() {
  clearTimeout(terrainBuildTimer);
  terrainBuildTimer = setTimeout(() => {
    terrainBuildTimer = null;
    requestTerrainBuild();
  }, TERRAIN_BUILD_DELAY_MS);
}

const terrainBuildPending = () => terrainBuildTimer !== null || terrainBuildInFlight || terrainBuildQueued;

function refreshActiveSpace() {
  monitorRenderCache = null;
  syncBasemap();
  syncSpacePanel();
  syncTerrainLayers();
  syncTerrainHandles();
  syncEchoFieldGeometry();
  syncTerrainControls();
  syncMarkers();
  render();
}

function setActiveSpace(next) {
  if (next === 'terrain' && !terrainAvailable()) return;
  const active = next === 'terrain' ? 'terrain' : 'map';
  if (state.activeSpace === active) return;
  state.activeSpace = active;
  if (active === 'terrain') {
    activeTool = null;
    document.querySelectorAll('[data-tool]').forEach(tool => tool.classList.remove('active'));
    clearBuildingHover();
  }
  terrainRevision += 1;
  if (active === 'terrain') {
    canonicalTerrainField = null;
    terrainField = null;
  }
  refreshActiveSpace();
  scheduleSave();
}

function setTerrainSpace(next, { activate = false } = {}) {
  state.terrainSpace = next;
  if (!next) {
    state.terrainPlacements = null;
    state.activeSpace = 'map';
  } else {
    state.terrainPlacements ??= terrainPlacementsFrom(state.mapPlacement);
    if (activate) {
      state.activeSpace = 'terrain';
      activeTool = null;
      document.querySelectorAll('[data-tool]').forEach(tool => tool.classList.remove('active'));
      clearBuildingHover();
    }
  }
  canonicalTerrainField = null;
  terrainField = null;
  terrainRevision += 1;
  refreshActiveSpace();
}

async function loadTerrain(bounds) {
  terrainLoading?.abort();
  const controller = new AbortController();
  terrainLoading = controller;
  syncTerrainControls();
  try {
    const capture = await captureTerrain(bounds, { signal: controller.signal });
    if (terrainLoading !== controller) return;
    const next = normalizeTerrainSpace({ ...(state.terrainSpace ?? {}), capture });
    state.terrainPlacements ??= terrainPlacementsFrom(state.mapPlacement);
    ['exterior', 'interior'].forEach(mode => placePointsInsideTerrain(
      normalizeTerrainSpace({ ...next, mode }), state.terrainPlacements[mode]
    ));
    setTerrainSpace(next, { activate: true });
  } catch (error) {
    if (error?.name !== 'AbortError') {
      console.error(error);
      window.alert('Terrain data could not be loaded.');
    }
    syncTerrainHandles();
  } finally {
    if (terrainLoading === controller) {
      terrainLoading = null;
      setTerrainPreview(null);
    }
    syncTerrainControls();
  }
}

function placePointsInsideTerrain(space, placement = activeTerrainPlacement()) {
  const frame = terrainFrame(space);
  const anchor = space.mode === 'interior' ? tallestCavityPoint(frame)?.point : frame.pivot;
  if (!anchor) return;
  const audible = point => placePoint(frame, point, 1).valid;
  const centre = frame.worldFromPoint(anchor);
  const offset = direction => frame.pointFromWorld({ x: centre.x + direction * frame.cellX * frame.scale, y: centre.y });
  if (placement.pointsLinked) {
    if (!audible(placement.source)) { placement.source = { ...anchor }; placement.listener = { ...anchor }; }
    return;
  }
  if (!audible(placement.source)) placement.source = offset(-1);
  if (!audible(placement.listener)) placement.listener = offset(1);
}

function removeImageLayer() {
  if (map.getLayer(IMAGE_LAYER_ID)) map.removeLayer(IMAGE_LAYER_ID);
  if (map.getSource(IMAGE_SOURCE_ID)) map.removeSource(IMAGE_SOURCE_ID);
  renderedImageDataUrl = null;
}

function syncImageLayer() {
  // A map jump temporarily makes isStyleLoaded() false while tiles refresh,
  // even though the style is ready for source and layer changes.
  if (!map.getStyle()) return;
  if (map.getLayer('osm')) map.setLayoutProperty('osm', 'visibility', imageBackground ? 'none' : 'visible');
  if (!imageBackground) {
    removeImageLayer();
    map.getSource('osm')?.setTiles(OSM_TILE_URLS);
    map.triggerRepaint();
    return;
  }
  const source = map.getSource(IMAGE_SOURCE_ID);
  if (source && renderedImageDataUrl === imageBackground.dataUrl) {
    source.setCoordinates(imageCoordinates(imageBackground));
    map.setPaintProperty(IMAGE_LAYER_ID, 'raster-opacity', imageBackground.opacity);
    return;
  }
  removeImageLayer();
  map.addSource(IMAGE_SOURCE_ID, { type: 'image', url: imageBackground.dataUrl, coordinates: imageCoordinates(imageBackground) });
  map.addLayer({
    id: IMAGE_LAYER_ID,
    type: 'raster',
    source: IMAGE_SOURCE_ID,
    paint: { 'raster-opacity': imageBackground.opacity, 'raster-fade-duration': 0 }
  }, map.getLayer('structures-fill') ? 'structures-fill' : map.getLayer('direct-route') ? 'direct-route' : undefined);
  renderedImageDataUrl = imageBackground.dataUrl;
}

function syncImageModeControls() {
  const active = Boolean(imageBackground);
  const imageButton = $('#image-background-button');
  imageButton.setAttribute('aria-pressed', String(active));
  imageButton.textContent = 'Image';
  $('#image-editor').hidden = false;
  document.querySelectorAll('[data-image-only]').forEach(button => { button.hidden = !active; });
  if (active) {
    $('#image-background-rotation').value = imageBackground.rotationDegrees;
    $('#image-background-opacity').value = imageBackground.opacity;
    syncImageSettingOutputs();
  } else {
    closeImagePanel();
  }
  const buildingsButton = $('#buildings-button');
  buildingsButton.disabled = active;
  buildingsButton.setAttribute('aria-pressed', String(active ? false : state.buildingsVisible));
  buildingsButton.title = active ? 'Building data is unavailable with an image background' : state.buildingsVisible ? 'Hide building data' : 'Load building data';
  setEchoFieldButtonDisabled(!state.buildingsVisible && state.structures.length === 0);
  syncTerrainControls();
}

function imageScaleGeoJson() {
  const guidePoints = imageScalePoints.length === 1 && imageScaleCursor
    ? [...imageScalePoints, imageScaleCursor]
    : imageScalePoints;
  return {
    type: 'FeatureCollection',
    features: [
      ...guidePoints.map(point => ({
        type: 'Feature', properties: {},
        geometry: { type: 'Point', coordinates: [point.longitude, point.latitude] }
      })),
      ...(guidePoints.length === 2 ? [{
        type: 'Feature', properties: {},
        geometry: { type: 'LineString', coordinates: guidePoints.map(point => [point.longitude, point.latitude]) }
      }] : [])
    ]
  };
}

function syncImageScaleGuide() {
  map.getSource(IMAGE_SCALE_SOURCE_ID)?.setData(imageScaleGeoJson());
  const instruction = $('#image-scale-instruction');
  const measurement = $('#image-scale-measurement');
  if (!instruction) return;
  const measuredPoint = imageScalePoints.length === 2 ? imageScalePoints[1] : imageScaleCursor;
  const hasMeasurement = imageScalePoints.length > 0 && measuredPoint;
  measurement.hidden = !hasMeasurement;
  measurement.textContent = hasMeasurement ? `${formatDistance(distanceMetres(imageScalePoints[0], measuredPoint))} at current scale` : '';
  if (!imageScalePoints.length) instruction.textContent = 'Select two points with a known distance on the image.';
  else if (imageScalePoints.length === 1) instruction.textContent = 'Select the other end of the known distance.';
  else instruction.textContent = 'Enter the known distance and set the scale.';
  $('#apply-image-scale').disabled = imageScalePoints.length !== 2;
}

function closeImagePanel() {
  activeImagePanel = null;
  imageScalePoints = [];
  imageScaleCursor = null;
  document.querySelectorAll('[data-image-panel]').forEach(button => button.setAttribute('aria-pressed', 'false'));
  document.querySelectorAll('[data-image-editor-panel]').forEach(panel => { panel.hidden = true; });
  syncImageScaleGuide();
  map.getCanvas().style.cursor = '';
}

function openImagePanel(name) {
  const next = activeImagePanel === name ? null : name;
  selectStructure(null);
  closeImagePanel();
  activeImagePanel = next;
  if (next) {
    activeTool = null;
    document.querySelectorAll('[data-tool]').forEach(button => button.classList.remove('active'));
    clearBuildingHover();
  }
  document.querySelectorAll('[data-image-panel]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.imagePanel === next)));
  document.querySelectorAll('[data-image-editor-panel]').forEach(panel => { panel.hidden = panel.dataset.imageEditorPanel !== next; });
  if (next === 'scale') map.getCanvas().style.cursor = 'crosshair';
}

function transformPlacedGeometry(previous, next) {
  state.mapPlacement.source = transformImagePoint(state.mapPlacement.source, previous, next);
  state.mapPlacement.listener = transformImagePoint(state.mapPlacement.listener, previous, next);
  state.reflectors.forEach(reflector => {
    Object.assign(reflector, transformImagePoint(reflector, previous, next));
    if (reflector.buildingEdge) reflector.buildingEdge = transformImageEdge(reflector.buildingEdge, previous, next);
  });
  const scale = next.widthMetres / previous.widthMetres;
  const rotationChange = next.rotationDegrees - previous.rotationDegrees;
  state.structures.forEach(structure => {
    structure.center = transformImagePoint(structure.center, previous, next);
    structure.verticesMetres.forEach(point => { point.x *= scale; point.y *= scale; });
    structure.rotationDegrees = ((structure.rotationDegrees + rotationChange + 180) % 360 + 360) % 360 - 180;
  });
}

function setImageBackground(next, { fit = false, transformGeometry = true } = {}) {
  const previous = imageBackground;
  const geometryChanged = previous && next && (
    previous.widthMetres !== next.widthMetres || previous.rotationDegrees !== next.rotationDegrees ||
    previous.center.latitude !== next.center.latitude || previous.center.longitude !== next.center.longitude
  );
  if (geometryChanged && transformGeometry) transformPlacedGeometry(previous, next);
  if (next && echoFieldEnabled) setEchoFieldEnabled(false);
  if (next && state.buildingsVisible) {
    state.buildingsVisible = false;
    if (map.getSource('overture-buildings')) setBuildingLayerVisibility(false);
    clearBuildingHover();
  }
  imageBackground = next;
  syncImageLayer();
  syncImageModeControls();
  syncMarkers();
  syncStructureGeometry();
  render();
  monitorRenderCache = null;
  scheduleSave();
  if (next && fit) {
    const bounds = imageCoordinates(next).reduce((value, coordinate) => value.extend(coordinate), new maplibregl.LngLatBounds());
    map.fitBounds(bounds, { padding: 40, duration: 0 });
  }
}

function materialOptions(selected, reflector) {
  const dataMaterial = normalizeFacadeMaterial(reflector.facadeMaterial);
  return Object.entries(MATERIAL_LABELS).map(([value, label]) =>
    `<option value="${value}"${value === selected ? ' selected' : ''}>${label}${value === dataMaterial ? ' · data' : value === 'inherit' && reflector.buildingEdge && !dataMaterial ? ' · no data' : ''}</option>`
  ).join('');
}

function formatDistance(metres) {
  return metres >= 1000 ? `${(metres / 1000).toFixed(2)} km` : `${metres.toFixed(1)} m`;
}

function updateDirectPathMetrics() {
  const placement = propagation();
  const output = $('#direct-path-metrics');
  if (!placement.valid) {
    const outside = !placement.source.valid ? 'Source' : 'Listener';
    output.textContent = `${outside} outside the ${state.terrainSpace.mode === 'interior' ? 'cavity' : 'terrain'}`;
    return;
  }
  const { pathMetres: metres, propagationSeconds: seconds } = directSoundMetrics(placement.source, placement.listener, soundSpeedMetresPerSecond(state.settings.echoField), placement.distanceMetres);
  output.textContent = `Source → Listener: ${formatDistance(metres)} · ${seconds.toFixed(3)} s${placement.directOccluded ? ' · blocked' : ''}`;
}

const reflectionCards = new Map();

function reflectionCard(reflector, index) {
  const reflectionLevelDb = reflector.levelDb ?? state.globalReflectionLevelDb;
  const element = document.createElement('article');
  element.className = 'reflection';
  element.innerHTML = `<header><h3>Reflector ${index + 1}</h3><select class="reflection-material" aria-label="Reflector ${index + 1} material">${materialOptions(reflector.material ?? 'inherit', reflector)}</select><button type="button" aria-label="Remove reflector ${index + 1}">×</button></header>
    <div class="metrics">
      <div class="metric"><span>Listener → reflector</span><strong></strong></div>
      <div class="metric"><span>Reflection delay</span><strong></strong></div>
    </div>
    <label class="level-control">
      <span>Reflection level <output>${reflectionLevelDb} dB</output></span>
      <input type="range" min="${REFLECTION_LEVEL_RANGE.minimum}" max="${REFLECTION_LEVEL_RANGE.maximum}" step="1" value="${reflectionLevelDb}" aria-label="Reflector ${index + 1} reflection level">
    </label>`;
  const [listenerLeg, delay] = element.querySelectorAll('.metric strong');
  const levelInput = element.querySelector('.level-control input');
  const levelOutput = element.querySelector('.level-control output');

  element.querySelector('header button').addEventListener('click', () => {
    state.reflectors = state.reflectors.filter(item => item.id !== reflector.id);
    syncMarkers(); render();
  });
  levelInput.addEventListener('input', () => {
    reflector.levelDb = Number(levelInput.value);
    levelOutput.textContent = `${reflector.levelDb} dB`;
    scheduleEchoFieldUpdate();
    scheduleSave();
  });
  const materialSelect = element.querySelector('.reflection-material');
  materialSelect.title = reflector.facadeMaterial ? `Material · building data: ${reflector.facadeMaterial}` : 'Material';
  materialSelect.addEventListener('change', event => {
    reflector.material = event.currentTarget.value;
    scheduleSave();
  });
  return { element, listenerLeg, delay, levelInput, levelOutput };
}

function renderReflectionList() {
  reflectionCards.clear();
  $('#reflection-list').replaceChildren(...visibleManualReflectors().map((reflector, index) => {
    const card = reflectionCard(reflector, index);
    reflectionCards.set(reflector.id, card);
    return card.element;
  }));
  $('#empty-reflections').hidden = audibleReflectors().length > 0 || terrainActive();
}

function updateReflectionMetrics() {
  state.reflectors.forEach(reflector => {
    const card = reflectionCards.get(reflector.id);
    if (!card) return;
    const { source, listener } = liftedMapPoints();
    const metrics = reflectionMetrics(source, listener, reflector, soundSpeedMetresPerSecond(state.settings.echoField));
    card.listenerLeg.textContent = formatDistance(metrics.listenerLegMetres);
    card.delay.textContent = metrics.blocked ? 'over the top' : `${metrics.propagationSeconds.toFixed(3)} s`;
  });
}

function updateReflectionLevels() {
  state.reflectors.forEach(reflector => {
    const card = reflectionCards.get(reflector.id);
    if (!card) return;
    card.levelInput.value = reflector.levelDb;
    card.levelOutput.textContent = `${reflector.levelDb} dB`;
  });
}

function syncLinkControls() {
  const linked = activePlacement().pointsLinked;
  $('#link-points').setAttribute('aria-pressed', String(linked));
  $('.link-label').textContent = linked ? 'Unlink' : 'Link';
  const arrivalsOnly = $('#arrivals-only');
  arrivalsOnly.closest('label').title = arrivalsOnly.title = linked
    ? 'Mute the source onset. Linked points share one place, so only the reflections remain.'
    : 'Mute the source onset and monitor only what arrives at the Listener.';
}

function renderGeometry({ rebuildField = true } = {}) {
  syncRoutes();
  syncMarkerHeights();
  if (state.terrainSpace) syncSpacePanel();
  updateDirectPathMetrics();
  updateReflectionMetrics();
  if (rebuildField) scheduleEchoFieldUpdate();
  scheduleSave();
}

function render() {
  syncLinkControls();
  renderReflectionList();
  renderGeometry();
}

map.on('load', () => {
  map.addSource('structures', { type: 'geojson', data: structuresGeoJson() });
  map.addSource('structure-edges', { type: 'geojson', data: structureEdgesGeoJson() });
  map.addLayer({ id: 'structures-fill', type: 'fill', source: 'structures', paint: { 'fill-color': ACCENT_COLOR, 'fill-opacity': ['case', ['boolean', ['get', 'selected'], false], .22, .1] } });
  map.addLayer({ id: 'structures-line', type: 'line', source: 'structures', paint: { 'line-color': ACCENT_COLOR, 'line-width': ['case', ['boolean', ['get', 'selected'], false], 4, 2], 'line-opacity': .95 } });
  map.addLayer({ id: 'structure-edge-hit', type: 'line', source: 'structure-edges', paint: { 'line-color': ACCENT_COLOR, 'line-width': 14, 'line-opacity': 0 } });
  map.on('mousedown', 'structure-edge-hit', event => {
    const feature = event.features?.[0];
    const structure = state.structures.find(item => item.id === feature?.properties?.id);
    const edgeIndex = Number(feature?.properties?.edgeIndex);
    if (!structure || !Number.isInteger(edgeIndex) || isNearStructureVertex(event.point, structure)) return;
    event.preventDefault();
    selectStructure(structure.id);
    structureEdgeDrag = {
      structure, edgeIndex, start: pointInStructureSpace(structure, pointFromLngLat(event.lngLat)),
      vertices: structure.verticesMetres.map(point => ({ ...point })), moved: false,
      restoreDragPan: map.dragPan.isEnabled()
    };
    map.dragPan.disable();
    map.getCanvas().style.cursor = 'grabbing';
  });
  map.on('click', 'structure-edge-hit', event => {
    if (suppressStructureEdgeClick) return;
    const feature = event.features?.[0];
    const structure = state.structures.find(item => item.id === feature?.properties?.id);
    const edgeIndex = Number(feature?.properties?.edgeIndex);
    if (!structure || !Number.isInteger(edgeIndex) || isNearStructureVertex(event.point, structure)) return;
    event.preventDefault();
    selectStructure(structure.id);
    structure.verticesMetres = insertVertex(structure.verticesMetres, edgeIndex, pointInStructureSpace(structure, pointFromLngLat(event.lngLat)));
    syncStructureGeometry();
    commitStructureGeometry();
  });
  map.on('mousedown', 'structures-fill', event => {
    const id = event.features?.[0]?.properties?.id;
    const structure = state.structures.find(item => item.id === id);
    if (!structure || isNearStructureVertex(event.point, structure)) return;
    if (map.queryRenderedFeatures(event.point, { layers: ['structure-edge-hit'] }).length) return;
    event.preventDefault();
    selectStructure(id);
    structureAreaDrag = {
      structure,
      start: pointFromLngLat(event.lngLat),
      center: { ...structure.center },
      restoreDragPan: map.dragPan.isEnabled()
    };
    map.dragPan.disable();
    map.getCanvas().style.cursor = 'grabbing';
  });
  map.addSource('direct-route', { type: 'geojson', data: directRouteGeoJson() });
  map.addLayer({ id: 'direct-route', type: 'line', source: 'direct-route', paint: { 'line-color': ACCENT_COLOR, 'line-width': 3, 'line-opacity': .95, 'line-dasharray': [2, 2] } });
  map.addSource('routes', { type: 'geojson', data: routeGeoJson() });
  map.addLayer({ id: 'routes', type: 'line', source: 'routes', paint: { 'line-color': ACCENT_COLOR, 'line-width': 3, 'line-opacity': .9 } });
  map.addSource('building-reflector-edges', { type: 'geojson', data: buildingEdgesGeoJson() });
  map.addLayer({ id: 'building-reflector-edge-casing', type: 'line', source: 'building-reflector-edges', paint: { 'line-color': '#111', 'line-width': 8, 'line-opacity': .9 } });
  map.addLayer({ id: 'building-reflector-edges', type: 'line', source: 'building-reflector-edges', paint: { 'line-color': ACCENT_COLOR, 'line-width': 5, 'line-opacity': .9 } });
  map.addSource('hovered-building-edge', { type: 'geojson', data: hoveredBuildingEdgeGeoJson() });
  map.addLayer({ id: 'hovered-building-edge-casing', type: 'line', source: 'hovered-building-edge', paint: { 'line-color': '#111', 'line-width': 7, 'line-opacity': .95 } });
  map.addLayer({ id: 'hovered-building-edge', type: 'line', source: 'hovered-building-edge', paint: { 'line-color': ACCENT_COLOR, 'line-width': 4, 'line-opacity': 1 } });
  map.addSource('echo-field', { type: 'geojson', data: circleGeoJson() });
  map.addLayer({ id: 'echo-field-fill', type: 'fill', source: 'echo-field', paint: { 'fill-color': ACCENT_COLOR, 'fill-opacity': .045 } });
  map.addLayer({ id: 'echo-field-line', type: 'line', source: 'echo-field', paint: { 'line-color': ACCENT_COLOR, 'line-width': 2, 'line-opacity': .9 } });
  map.addSource(IMAGE_SCALE_SOURCE_ID, { type: 'geojson', data: imageScaleGeoJson() });
  map.addLayer({ id: `${IMAGE_SCALE_SOURCE_ID}-line`, type: 'line', source: IMAGE_SCALE_SOURCE_ID, filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': ACCENT_COLOR, 'line-width': 4, 'line-opacity': 1, 'line-dasharray': [1, 1] } });
  map.addLayer({ id: `${IMAGE_SCALE_SOURCE_ID}-points`, type: 'circle', source: IMAGE_SCALE_SOURCE_ID, filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 6, 'circle-color': ACCENT_COLOR, 'circle-stroke-width': 3, 'circle-stroke-color': '#111' } });
  map.addSource('terrain-draft', { type: 'geojson', data: terrainDraftGeoJson() });
  map.addLayer({ id: 'terrain-draft', type: 'line', source: 'terrain-draft', paint: { 'line-color': ACCENT_COLOR, 'line-width': 2, 'line-dasharray': [2, 2] } });
  syncImageLayer();
  syncImageModeControls();
  syncBasemap();
  syncTerrainLayers();
  syncTerrainHandles();
  syncTerrainControls();
  syncSpacePanel();
  syncMarkers();
  syncStructureGeometry();
  if (echoFieldEnabled) setEchoFieldEnabled(true, automaticReflectors);
  else render();
});

let suppressTerrainClick = false;

map.on('mousedown', event => {
  if (!terrainDrawArmed || fromMarker(event)) return;
  event.preventDefault();
  terrainDraft = { start: event.lngLat, end: event.lngLat, restoreDragPan: map.dragPan.isEnabled() };
  map.dragPan.disable();
});

map.on('mousemove', event => {
  if (terrainMove) {
    const dx = event.lngLat.lng - terrainMove.start.lng;
    const dy = event.lngLat.lat - terrainMove.start.lat;
    terrainMove.end = event.lngLat;
    terrainMove.moved ||= Math.hypot(event.point.x - terrainMove.startPoint.x, event.point.y - terrainMove.startPoint.y) > 3;
    setTerrainPreview(terrainMove.ring.map(([longitude, latitude]) => [longitude + dx, latitude + dy]));
    map.getCanvas().style.cursor = 'grabbing';
    return;
  }
  if (!terrainDraft) return;
  terrainDraft.end = event.lngLat;
  map.getSource('terrain-draft')?.setData(terrainDraftGeoJson());
});

const fromMarker = event => Boolean(event.originalEvent?.target?.closest?.('.maplibregl-marker'));

map.on('mousedown', 'terrain-hit', event => {
  if (terrainDrawArmed || activeTool || terrainLoading || event.defaultPrevented || fromMarker(event)) return;
  if (map.queryRenderedFeatures(event.point, { layers: ['structures-fill'] }).length) return;
  const frame = activeTerrainFrame();
  if (!frame) return;
  event.preventDefault();
  const corners = frame.footprint().map(point => [point.longitude, point.latitude]);
  terrainMove = { start: event.lngLat, end: event.lngLat, startPoint: event.point, ring: [...corners, corners[0]], restoreDragPan: map.dragPan.isEnabled(), moved: false };
  map.dragPan.disable();
});

map.on('mouseenter', 'terrain-hit', () => { if (!terrainDrawArmed && !activeTool) map.getCanvas().style.cursor = 'grab'; });
map.on('mouseleave', 'terrain-hit', () => { if (!terrainMove && !terrainDrawArmed) map.getCanvas().style.cursor = ''; });

function finishTerrainMove() {
  if (!terrainMove) return;
  const { start, end, restoreDragPan, moved } = terrainMove;
  terrainMove = null;
  if (restoreDragPan) map.dragPan.enable();
  map.getCanvas().style.cursor = '';
  if (!moved || !state.terrainSpace) { setTerrainPreview(null); return; }
  suppressTerrainClick = true;
  setTimeout(() => { suppressTerrainClick = false; }, 0);
  const { bounds } = state.terrainSpace.capture;
  const dx = end.lng - start.lng;
  const dy = end.lat - start.lat;
  const next = { west: bounds.west + dx, east: bounds.east + dx, south: bounds.south + dy, north: bounds.north + dy };
  if (validCaptureBounds(next)) loadTerrain(next);
  else setTerrainPreview(null);
}

document.addEventListener('mouseup', finishTerrainMove);

function finishTerrainDraft() {
  if (!terrainDraft) return;
  const { start, end, restoreDragPan } = terrainDraft;
  terrainDraft = null;
  map.getSource('terrain-draft')?.setData(terrainDraftGeoJson());
  if (restoreDragPan) map.dragPan.enable();
  suppressTerrainClick = true;
  setTimeout(() => { suppressTerrainClick = false; }, 0);
  setTerrainDrawArmed(false);
  const bounds = boundsBetween(pointFromLngLat(start), pointFromLngLat(end));
  if (validCaptureBounds(bounds)) loadTerrain(bounds);
  else window.alert(TERRAIN_SIZE_MESSAGE);
}

document.addEventListener('mouseup', finishTerrainDraft);

$('#terrain-button').addEventListener('click', () => {
  if (terrainAvailable() && terrainDrawArmed) setTerrainDrawArmed(false);
  if (terrainActive()) {
    setActiveSpace('map');
    return;
  }
  if (terrainAvailable()) {
    setActiveSpace('terrain');
    return;
  }
  setTerrainDrawArmed(!terrainDrawArmed);
});

$('#terrain-draw-button').addEventListener('click', () => {
  if (!terrainAvailable() || terrainLoading) return;
  setTerrainDrawArmed(!terrainDrawArmed);
});

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || (!terrainDrawArmed && !terrainDraft)) return;
  event.preventDefault();
  const restoreDragPan = terrainDraft?.restoreDragPan;
  terrainDraft = null;
  map.getSource('terrain-draft')?.setData(terrainDraftGeoJson());
  if (restoreDragPan) map.dragPan.enable();
  setTerrainDrawArmed(false);
});

function nearestBuildingWall(feature, clickPoint) {
  const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  let nearest = null;
  polygons.flat().forEach(ring => {
    for (let index = 1; index < ring.length; index += 1) {
      const start = ring[index - 1];
      const end = ring[index];
      const a = map.project(start);
      const b = map.project(end);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared ? Math.max(0, Math.min(1, ((clickPoint.x - a.x) * dx + (clickPoint.y - a.y) * dy) / lengthSquared)) : 0;
      const x = a.x + t * dx;
      const y = a.y + t * dy;
      const distanceSquared = (clickPoint.x - x) ** 2 + (clickPoint.y - y) ** 2;
      if (!nearest || distanceSquared < nearest.distanceSquared) {
        nearest = {
          distanceSquared,
          point: { longitude: start[0] + t * (end[0] - start[0]), latitude: start[1] + t * (end[1] - start[1]) },
          edge: [start, end]
        };
      }
    }
  });
  return nearest;
}

function rebuildEchoField() {
  if (!echoFieldEnabled || terrainActive()) return;
  echoFieldUsesSavedReflectors = false;
  const walls = state.structures.flatMap(structureWalls);
  const seenEdges = new Set();
  if (state.buildingsVisible && map.getSource('overture-buildings')) map.querySourceFeatures('overture-buildings', { sourceLayer: 'buildings' }).forEach(feature => {
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.type === 'MultiPolygon' ? feature.geometry.coordinates : [];
    const facadeMaterial = feature.properties.facade_material
      ?? feature.properties['facade:material']
      ?? feature.properties['building:material']
      ?? feature.properties.material;
    polygons.flat().forEach(ring => {
      for (let index = 1; index < ring.length; index += 1) {
        const edge = [ring[index - 1], ring[index]];
        const key = edgeKey(edge);
        if (seenEdges.has(key)) continue;
        seenEdges.add(key);
        walls.push({ edge, key, ring, facadeMaterial, heightMetres: buildingHeightMetres(feature.properties) });
      }
    });
  });
  const field = reflectionField({
    source: state.mapPlacement.source, listener: state.mapPlacement.listener, walls, radiusMetres: state.settings.echoFieldRadiusMetres
  });
  const candidates = walls.flatMap(wall => {
    const reflection = wallReflectionCandidate(field, wall, distanceMetres);
    if (!reflection) return [];
    const lifted = liftedMapPoints();
    const pathMetres = reflectionMetrics(lifted.source, lifted.listener, { ...reflection.point, heightMetres: wall.heightMetres }).pathMetres;
    return [{
      id: `area-${wall.key}`,
      ...reflection.point,
      ...(Number.isFinite(wall.heightMetres) ? { heightMetres: wall.heightMetres } : {}),
      buildingEdge: wall.edge,
      facadeMaterial: wall.facadeMaterial,
      material: wall.structureId ? state.structures.find(structure => structure.id === wall.structureId)?.material ?? 'inherit' : normalizeFacadeMaterial(wall.facadeMaterial) ?? 'inherit',
      levelDb: state.globalReflectionLevelDb + (reflection.kind === 'diffuse' ? -9 : 0),
      reflectionKind: reflection.kind,
      pathMetres,
      rank: pathMetres * (reflection.kind === 'diffuse' ? 2.5 : 1)
    }];
  });
  candidates.sort((a, b) => a.rank - b.rank);
  const maximumSurfaces = state.settings.echoField.maxSurfaces;
  automaticReflectors = candidates.slice(0, maximumSurfaces);
  const allReflectors = audibleReflectors();
  if (state.settings.echoField.buildingOcclusion) {
    const visibility = reflectorVisibilityGraph(field, allReflectors);
    allReflectors.forEach(reflector => { reflector.visibleReflectorIds = visibility.get(reflector.id) ?? []; });
  } else allReflectors.forEach(reflector => { delete reflector.visibleReflectorIds; });
  invalidateRenderedPlayback();
  const button = $('#echo-field-button');
  button.textContent = `Echo field · ${automaticReflectors.length}${candidates.length > maximumSurfaces ? '+' : ''}`;
  button.title = `${state.settings.echoFieldRadiusMetres.toFixed(0)} m radius · ${automaticReflectors.length} active surfaces`;
  syncEchoFieldGeometry();
  syncRoutes();
  $('#empty-reflections').hidden = audibleReflectors().length > 0;
}

function scheduleEchoFieldUpdate() {
  if (terrainActive()) { scheduleTerrainBuild(); return; }
  if (!echoFieldEnabled || echoFieldUsesSavedReflectors) return;
  clearTimeout(echoFieldUpdateTimer);
  echoFieldUpdateTimer = setTimeout(rebuildEchoField, 80);
}

map.on('mousemove', event => {
  if (structureEdgeDrag) {
    const point = pointInStructureSpace(structureEdgeDrag.structure, pointFromLngLat(event.lngLat));
    const delta = { x: point.x - structureEdgeDrag.start.x, y: point.y - structureEdgeDrag.start.y };
    if (Math.hypot(delta.x, delta.y) > .02) structureEdgeDrag.moved = true;
    const { edgeIndex, vertices, structure } = structureEdgeDrag;
    structure.verticesMetres = moveEdgeVertices(vertices, edgeIndex, delta);
    positionStructureMarkers(structure);
    commitStructureGeometry();
    map.getCanvas().style.cursor = 'grabbing';
    return;
  }
  if (structureAreaDrag) {
    const point = pointFromLngLat(event.lngLat);
    structureAreaDrag.structure.center = {
      latitude: structureAreaDrag.center.latitude + point.latitude - structureAreaDrag.start.latitude,
      longitude: structureAreaDrag.center.longitude + point.longitude - structureAreaDrag.start.longitude
    };
    positionStructureMarkers(structureAreaDrag.structure);
    commitStructureGeometry();
    map.getCanvas().style.cursor = 'grabbing';
    return;
  }
  if (activeImagePanel === 'scale' && imageBackground) {
    imageScaleCursor = pointFromLngLat(event.lngLat);
    syncImageScaleGuide();
    map.getCanvas().style.cursor = 'crosshair';
    return;
  }
  if (activeTool !== 'reflector' || !state.buildingsVisible || !map.getLayer('overture-building-fill')) {
    if (hoveredBuildingEdge) clearBuildingHover();
    return;
  }
  const building = map.queryRenderedFeatures(event.point, { layers: ['overture-building-fill'] })[0];
  const wall = building ? nearestBuildingWall(building, event.point) : null;
  hoveredBuildingEdge = wall?.edge ?? null;
  map.getSource('hovered-building-edge')?.setData(hoveredBuildingEdgeGeoJson());
  map.getCanvas().style.cursor = wall ? 'crosshair' : '';
});

function finishStructureAreaDrag() {
  const drag = structureEdgeDrag ?? structureAreaDrag;
  if (!drag) return;
  const restoreDragPan = drag.restoreDragPan;
  if (structureEdgeDrag?.moved) {
    suppressStructureEdgeClick = true;
    setTimeout(() => { suppressStructureEdgeClick = false; }, 0);
  }
  structureEdgeDrag = null;
  structureAreaDrag = null;
  if (restoreDragPan) map.dragPan.enable();
  map.getCanvas().style.cursor = '';
  syncStructureGeometry();
  commitStructureGeometry();
}

map.on('mouseup', finishStructureAreaDrag);
document.addEventListener('mouseup', finishStructureAreaDrag);

map.on('mouseout', clearBuildingHover);

map.on('click', event => {
  if (suppressTerrainClick || terrainDrawArmed) return;
  if (activeImagePanel === 'scale' && imageBackground) {
    const point = pointFromLngLat(event.lngLat);
    imageScalePoints = imageScalePoints.length < 2 ? [...imageScalePoints, point] : [point];
    imageScaleCursor = null;
    syncImageScaleGuide();
    return;
  }
  if (event.defaultPrevented) return;
  const structureFeature = map.queryRenderedFeatures(event.point, { layers: ['structures-fill'] })[0];
  if (structureFeature) { selectStructure(structureFeature.properties.id); return; }
  if (!activeTool) selectStructure(null);
  if (!activeTool) return;
  const point = pointFromLngLat(event.lngLat);
  const placement = activePlacement();
  if (activeTool === 'source') {
    releaseSavedEchoField();
    placement.source = point;
    if (placement.pointsLinked) placement.listener = { ...point };
  }
  if (activeTool === 'listener') {
    releaseSavedEchoField();
    placement.listener = point;
    if (placement.pointsLinked) placement.source = { ...point };
  }
  if (activeTool === 'reflector') {
    const building = state.buildingsVisible
      ? map.queryRenderedFeatures(event.point, { layers: ['overture-building-fill'] })[0]
      : null;
    const wall = building ? nearestBuildingWall(building, event.point) : null;
    const facadeMaterial = building && (
      building.properties.facade_material
      ?? building.properties['facade:material']
      ?? building.properties['building:material']
      ?? building.properties.material
    );
    state.reflectors.push({
      id: crypto.randomUUID(),
      levelDb: state.globalReflectionLevelDb,
      material: normalizeFacadeMaterial(facadeMaterial) ?? 'inherit',
      ...(wall?.point ?? point),
      ...(wall ? { buildingEdge: wall.edge, buildingId: building.id, facadeMaterial } : {}),
      ...(wall && Number.isFinite(buildingHeightMetres(building.properties)) ? { heightMetres: buildingHeightMetres(building.properties) } : {})
    });
  }
  syncMarkers(); render();
});

document.querySelectorAll('[data-tool]').forEach(button => button.addEventListener('click', () => {
  if (terrainDrawArmed) setTerrainDrawArmed(false);
  activeTool = activeTool === button.dataset.tool ? null : button.dataset.tool;
  document.querySelectorAll('[data-tool]').forEach(item => item.classList.toggle('active', item.dataset.tool === activeTool));
  if (activeTool !== 'reflector') clearBuildingHover();
}));

function requestConfirmation({ title, message, confirmLabel = 'Confirm' }) {
  const dialog = $('#confirmation-dialog');
  $('#confirmation-title').textContent = title;
  $('#confirmation-message').textContent = message;
  $('#confirmation-submit').textContent = confirmLabel;
  dialog.returnValue = 'cancel';
  dialog.showModal();
  dialog.focus({ preventScroll: true });
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
}

const echoSettingInputs = {
  durationSeconds: '#setting-duration',
  maxSurfaces: '#setting-surfaces',
  pointPathLimit: '#setting-point-paths',
  pointMaxBounces: '#setting-point-bounces',
  pointPersistence: '#setting-point-persistence',
  airTemperatureCelsius: '#setting-air-temperature',
  airHumidityPercent: '#setting-air-humidity',
  airPressureKpa: '#setting-air-pressure',
  airAbsorptionAmount: '#setting-air-amount',
  geometricSpreadingAmount: '#setting-geometric-spreading',
  materialColorationAmount: '#setting-material-coloration',
  lateFieldLevelDb: '#setting-late-level',
  lateWalks: '#setting-late-walks',
  maxBounces: '#setting-bounces',
  cutoffDb: '#setting-cutoff',
  tailPersistence: '#setting-persistence',
  fdnTailSeconds: '#setting-fdn-tail',
  fdnDensity: '#setting-fdn-density',
  fdnDamping: '#setting-fdn-damping',
  geometryInfluence: '#setting-geometry-influence'
};

const echoSettingOutputs = {
  durationSeconds: ['#setting-duration-value', value => `${value} s`],
  maxSurfaces: ['#setting-surfaces-value', value => value],
  pointPathLimit: ['#setting-point-paths-value', value => Number(value).toLocaleString('en-US')],
  pointMaxBounces: ['#setting-point-bounces-value', value => value],
  pointPersistence: ['#setting-point-persistence-value', value => `${Math.round(value * 100)}%`],
  airTemperatureCelsius: ['#setting-air-temperature-value', value => `${value} °C`],
  airHumidityPercent: ['#setting-air-humidity-value', value => `${value}%`],
  airPressureKpa: ['#setting-air-pressure-value', value => `${Number(value).toFixed(1)} kPa`],
  airAbsorptionAmount: ['#setting-air-amount-value', value => `${Number(value).toFixed(2)}× ISO`],
  geometricSpreadingAmount: ['#setting-geometric-spreading-value', value => Number(value) === 0 ? 'Off' : Number(value) === 1 ? '1/r' : `1/r^${Number(value).toFixed(2)}`],
  materialColorationAmount: ['#setting-material-coloration-value', value => `${Number(value).toFixed(2)}×`],
  lateFieldLevelDb: ['#setting-late-level-value', value => `${Number(value) > 0 ? '+' : ''}${value} dB`],
  lateWalks: ['#setting-late-walks-value', value => Number(value).toLocaleString('en-US')],
  maxBounces: ['#setting-bounces-value', value => value],
  cutoffDb: ['#setting-cutoff-value', value => `${value} dB`],
  tailPersistence: ['#setting-persistence-value', value => Number(value).toFixed(2)],
  fdnTailSeconds: ['#setting-fdn-tail-value', value => `${value} s`],
  fdnDensity: ['#setting-fdn-density-value', value => `${Math.round(value * 100)}%`],
  fdnDamping: ['#setting-fdn-damping-value', value => `${Math.round(value * 100)}%`],
  geometryInfluence: ['#setting-geometry-influence-value', value => `${Math.round(value * 100)}%`]
};

function syncLateModeSettings() {
  const mode = $('#setting-late-mode').value;
  document.querySelectorAll('[data-late-mode]').forEach(row => { row.hidden = row.dataset.lateMode !== mode; });
}

function syncPointModeSettings() {
  const mode = $('#setting-point-mode').value;
  document.querySelectorAll('[data-point-mode]').forEach(row => { row.hidden = row.dataset.pointMode !== mode; });
}

function syncAirModeSettings() {
  const mode = $('#setting-air-mode').value;
  document.querySelectorAll('[data-air-mode]').forEach(row => { row.hidden = row.dataset.airMode !== mode; });
  document.querySelectorAll('[data-air-active]').forEach(row => { row.hidden = mode === 'off'; });
}

$('#setting-late-mode').addEventListener('change', syncLateModeSettings);
$('#setting-point-mode').addEventListener('change', syncPointModeSettings);
$('#setting-air-mode').addEventListener('change', syncAirModeSettings);

function syncEchoSettingOutput(setting) {
  const [outputSelector, format] = echoSettingOutputs[setting];
  $(outputSelector).textContent = format($(echoSettingInputs[setting]).value);
}

Object.entries(echoSettingInputs).forEach(([setting, selector]) => {
  const input = $(selector);
  const { minimum, maximum, step } = ECHO_FIELD_SETTINGS[setting];
  Object.assign(input, { min: minimum, max: maximum, step });
  input.addEventListener('input', () => syncEchoSettingOutput(setting));
});

function fillEchoSettings(echoField, playbackMode) {
  $('#setting-playback-mode').value = playbackMode;
  $('#setting-building-occlusion').checked = echoField.buildingOcclusion;
  $('#setting-late-mode').value = echoField.lateMode;
  $('#setting-point-mode').value = echoField.pointMode;
  $('#setting-air-mode').value = echoField.airMode;
  Object.entries(echoSettingInputs).forEach(([setting, selector]) => {
    $(selector).value = echoField[setting];
    syncEchoSettingOutput(setting);
  });
  syncLateModeSettings();
  syncPointModeSettings();
  syncAirModeSettings();
}

$('#settings-defaults').addEventListener('click', () => fillEchoSettings(DEFAULT_ECHO_FIELD_SETTINGS, 'live'));

$('#echo-settings-button').addEventListener('click', () => {
  fillEchoSettings(state.settings.echoField, state.settings.playbackMode);
  selectSettingsTab('echo');
  if (state.terrainSpace) openTerrainSettings(state.terrainSpace);
  const dialog = $('#echo-settings-dialog');
  dialog.returnValue = 'cancel';
  dialog.showModal();
  dialog.focus({ preventScroll: true });
});

$('#echo-settings-dialog').addEventListener('close', event => {
  if (event.currentTarget.returnValue !== 'save') return;
  state.settings.playbackMode = $('#setting-playback-mode').value === 'rendered' ? 'rendered' : 'live';
  renderedForLongSound = false;
  state.settings.echoField = normalizeEchoFieldSettings({
    ...Object.fromEntries(Object.keys(echoSettingInputs).map(setting => [setting, $(echoSettingInputs[setting]).value])),
    lateMode: $('#setting-late-mode').value,
    pointMode: $('#setting-point-mode').value,
    airMode: $('#setting-air-mode').value,
    buildingOcclusion: $('#setting-building-occlusion').checked,
    sourceAirMetres: importedAudioAirMetres
  });
  if (state.terrainSpace) applyTerrainSettings();
  scheduleSave();
  syncPlayButton();
  renderGeometry();
  if (echoFieldEnabled) rebuildEchoField();
});

function selectSettingsTab(name) {
  $('#settings-defaults').hidden = name !== 'echo';
  document.querySelectorAll('[data-settings-tab]').forEach(tab => {
    const selected = tab.dataset.settingsTab === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(`#${tab.getAttribute('aria-controls')}`).hidden = !selected;
  });
}

document.querySelectorAll('[data-settings-tab]').forEach(tab => {
  tab.addEventListener('click', () => selectSettingsTab(tab.dataset.settingsTab));
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const tabs = [...document.querySelectorAll('[data-settings-tab]')].filter(item => !item.disabled);
    const next = tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    selectSettingsTab(next.dataset.settingsTab);
    next.focus();
  });
});

/** Three decades of scale over 1200 steps put 1:1 exactly on a step. */
const SLIDER_STEPS = 1200;
const GROUND_OFF_POSITION = GROUND_REFLECTION_RANGE.minimum - 1;
const geometricValue = (position, minimum, maximum) => minimum * (maximum / minimum) ** (position / SLIDER_STEPS);
const geometricPosition = (value, minimum, maximum) => maximum <= minimum ? SLIDER_STEPS : Math.round(Math.log(value / minimum) / Math.log(maximum / minimum) * SLIDER_STEPS);

function formatScale(scale) {
  if (Math.abs(scale - 1) < 1e-9) return '1:1';
  const ratio = scale < 1 ? 1 / scale : scale;
  const text = ratio < 10 ? ratio.toFixed(1).replace(/\.0$/, '') : String(Math.round(ratio));
  return scale < 1 ? `1:${text}` : `${text}:1`;
}

const formatGround = decibels => decibels === null ? 'Off' : `${decibels > 0 ? '+' : ''}${decibels} dB`;

function setTerrainSlider(input, position, value) {
  input.value = position;
  input.dataset.openedAt = input.value;
  input.dataset.storedValue = String(value);
}

const terrainSliderValue = (input, convert) => input.value === input.dataset.openedAt ? Number(input.dataset.storedValue) : convert(Number(input.value));

function pendingTerrainSurface() {
  const ground = Number($('#terrain-ground').value);
  return {
    material: $('#terrain-material').value,
    scattering: terrainSliderValue($('#terrain-scattering'), value => value),
    groundReflectionDb: ground === GROUND_OFF_POSITION ? null : ground
  };
}

function syncTerrainSettingOutputs() {
  const pending = pendingTerrainSurface();
  $('#terrain-scattering-value').textContent = `${Math.round(pending.scattering * 100)}%`;
  $('#terrain-ground-value').textContent = formatGround(pending.groundReflectionDb);
}

function openTerrainSettings(space) {
  const range = floorRange(space.capture.values);
  $('#terrain-material').value = space.material;
  setTerrainSlider($('#terrain-scattering'), space.scattering, space.scattering);
  Object.assign($('#terrain-ground'), { min: GROUND_OFF_POSITION, max: GROUND_REFLECTION_RANGE.maximum });
  $('#terrain-ground').value = space.groundReflectionDb ?? GROUND_OFF_POSITION;
  const cellMetres = space.capture.widthMetres / space.capture.columns;
  $('#terrain-data').textContent = `${formatDistance(cellMetres)} cells · ${Math.round(range.minimum)}–${Math.round(range.maximum + 1)} m`;
  syncTerrainSettingOutputs();
}

['#terrain-material', '#terrain-scattering', '#terrain-ground'].forEach(selector => {
  $(selector).addEventListener('input', syncTerrainSettingOutputs);
});

$('#delete-terrain').addEventListener('click', async () => {
  const confirmed = await requestConfirmation({
    title: 'Delete terrain?',
    message: 'Delete the captured terrain and its settings? The map space remains unchanged.',
    confirmLabel: 'Delete terrain'
  });
  if (!confirmed) return;
  terrainLoading?.abort();
  $('#echo-settings-dialog').close('cancel');
  setTerrainSpace(null);
  scheduleSave();
});

function applyTerrainSettings() {
  updateTerrainSpace(pendingTerrainSurface());
}

function updateTerrainSpace(changes, { rebuildImage = false } = {}) {
  const next = normalizeTerrainSpace({ ...state.terrainSpace, ...changes });
  if (!next) return;
  const modeChanged = next.mode !== state.terrainSpace.mode;
  state.terrainSpace = next;
  canonicalTerrainField = null;
  terrainField = null;
  if (rebuildImage) renderedTerrainImage = null;
  syncTerrainLayers();
  if (modeChanged) syncMarkers();
  else syncMarkerHeights();
  syncTerrainControls();
  syncSpacePanel();
  renderGeometry();
}

function updateTerrainScale(scale) {
  const next = normalizeTerrainSpace({ ...state.terrainSpace, scale });
  if (!next || next.scale === state.terrainSpace.scale) return;
  state.terrainSpace = next;
  terrainField = canonicalTerrainField ? scaleTerrainField(canonicalTerrainField, next.scale) : null;
  monitorRenderCache = null;
  invalidateRenderedPlayback();
  syncTerrainLayers();
  syncTerrainControls();
  syncSpacePanel();
  renderGeometry({ rebuildField: !canonicalTerrainField && !terrainBuildInFlight });
}

let spaceViewMode = 'space';
let spaceView = { ...DEFAULT_SPACE_VIEW };
let spaceDrawFrame = null;
let spaceWindowOpen = false;
let spaceScene = null;
let spacePulses = [];

function spacePalette() {
  const styles = getComputedStyle(document.documentElement);
  const accent = styles.getPropertyValue('--accent').trim();
  return {
    accent,
    ink: styles.getPropertyValue('--ink').trim(),
    muted: styles.getPropertyValue('--muted').trim(),
    panel: styles.getPropertyValue('--panel').trim(),
    line: '#b8b8b8',
    rock: '#262626',
    air: `${accent}1f`
  };
}

function drawSpaceViews() {
  spaceDrawFrame = null;
  const frame = activeTerrainFrame();
  if (!frame) return;
  const placement = propagation();
  const canvas = spaceWindowOpen ? $('#space-window-canvas') : $('#space-canvas');
  if (!canvas.clientWidth || !canvas.clientHeight) return;
  const palette = spacePalette();
  if (spaceViewMode === 'section') {
    spaceScene = null;
    const terrainPlacement = activeTerrainPlacement();
    drawSection(canvas, { frame, placement, section: sectionProfile(frame, terrainPlacement.source, terrainPlacement.listener) }, palette);
    return;
  }
  const toScreen = drawSpace(canvas, { frame, placement, reflectors: audibleReflectors() }, spaceView, palette);
  spaceScene = captureSpaceScene(canvas, toScreen);
  if (spacePulses.length) paintSpacePulses(spaceScene, spacePulses);
}

function showSpacePulses(pulses) {
  spacePulses = pulses;
  if (spaceScene && !spaceDrawFrame) paintSpacePulses(spaceScene, pulses);
}

function scheduleSpaceDraw() {
  if (!terrainActive() || spaceDrawFrame) return;
  spaceDrawFrame = requestAnimationFrame(drawSpaceViews);
}

function syncSpaceHeightSlider(role, placed) {
  const maximum = placed.valid ? placed.maximumHeightSettingMetres : EXTERIOR_HEIGHT_RANGE.maximum;
  const height = placed.heightSettingMetres ?? terrainHeightMetres(state.terrainSpace, role);
  const input = $(`#space-${role}-height`);
  input.dataset.maximum = String(maximum);
  if (document.activeElement !== input) input.value = geometricPosition(Math.min(maximum, height), EXTERIOR_HEIGHT_RANGE.minimum, maximum);
  $(`#space-${role}-height-value`).textContent = placed.valid ? formatHeight(placed.heightMetres) : '—';
}

function syncSpacePanel() {
  const space = terrainActive() ? state.terrainSpace : null;
  $('#space-panel').hidden = !space;
  if (!space) {
    if (spaceWindowOpen) closeSpaceWindow();
    return;
  }
  document.querySelectorAll('[data-space-mode]').forEach(button => button.setAttribute('aria-checked', String(button.dataset.spaceMode === space.mode)));
  document.querySelectorAll('[data-space-view]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.spaceView === spaceViewMode)));
  document.querySelectorAll('[data-space-control]').forEach(row => { row.hidden = row.dataset.spaceControl !== space.mode; });
  $('#space-window-title').textContent = space.mode === 'interior' ? 'Chamber' : 'Canyon';
  const range = floorRange(space.capture.values);
  const floorInput = $('#space-floor');
  Object.assign(floorInput, { min: Math.floor(range.minimum), max: Math.ceil(range.maximum) });
  if (document.activeElement !== floorInput) floorInput.value = space.floorElevationMetres;
  $('#space-floor-value').textContent = `${Math.round(space.floorElevationMetres)} m`;
  const scaleInput = $('#space-scale');
  if (document.activeElement !== scaleInput) scaleInput.value = geometricPosition(space.scale, TERRAIN_SCALE_RANGE.minimum, TERRAIN_SCALE_RANGE.maximum);
  $('#space-scale-value').textContent = formatScale(space.scale);
  const placement = propagation();
  syncSpaceHeightSlider('listener', placement.listener);
  syncSpaceHeightSlider('source', placement.source);
  scheduleSpaceDraw();
}

document.querySelectorAll('[data-space-mode]').forEach(button => button.addEventListener('click', () => {
  if (!state.terrainSpace || state.terrainSpace.mode === button.dataset.spaceMode) return;
  const next = normalizeTerrainSpace({ ...state.terrainSpace, mode: button.dataset.spaceMode });
  placePointsInsideTerrain(next, state.terrainPlacements[next.mode]);
  updateTerrainSpace({ mode: next.mode }, { rebuildImage: true });
}));

document.querySelectorAll('[data-space-view]').forEach(button => button.addEventListener('click', () => {
  spaceViewMode = button.dataset.spaceView;
  syncSpacePanel();
}));

$('#space-floor').addEventListener('input', event => {
  updateTerrainSpace({ floorElevationMetres: Number(event.currentTarget.value) }, { rebuildImage: true });
});

$('#space-scale').addEventListener('input', event => {
  updateTerrainScale(geometricValue(Number(event.currentTarget.value), TERRAIN_SCALE_RANGE.minimum, TERRAIN_SCALE_RANGE.maximum));
});

['listener', 'source'].forEach(role => {
  $(`#space-${role}-height`).addEventListener('input', event => {
    const maximum = Number(event.currentTarget.dataset.maximum) || EXTERIOR_HEIGHT_RANGE.maximum;
    const mode = state.terrainSpace.mode;
    updateTerrainSpace({
      heightsMetres: {
        ...state.terrainSpace.heightsMetres,
        [mode]: {
          ...state.terrainSpace.heightsMetres[mode],
          [role]: geometricValue(Number(event.currentTarget.value), EXTERIOR_HEIGHT_RANGE.minimum, maximum)
        }
      }
    });
  });
});

['#space-floor', '#space-scale', '#space-listener-height', '#space-source-height'].forEach(selector => {
  $(selector).addEventListener('change', () => { syncSpacePanel(); scheduleSave(); });
});

$('#space-floor').addEventListener('change', () => {
  const terrainPlacement = activeTerrainPlacement();
  const previous = { source: terrainPlacement.source, listener: terrainPlacement.listener };
  placePointsInsideTerrain(state.terrainSpace, terrainPlacement);
  if (previous.source === terrainPlacement.source && previous.listener === terrainPlacement.listener) return;
  syncMarkers();
  renderGeometry();
});

function attachOrbit(canvas) {
  let drag = null;
  canvas.addEventListener('pointerdown', event => {
    if (spaceViewMode !== 'space') return;
    drag = { x: event.clientX, y: event.clientY, view: { ...spaceView } };
    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', event => {
    if (!drag) return;
    spaceView = {
      ...spaceView,
      yaw: drag.view.yaw + (event.clientX - drag.x) * .008,
      pitch: Math.min(1.45, Math.max(.08, drag.view.pitch + (event.clientY - drag.y) * .006))
    };
    scheduleSpaceDraw();
  });
  const release = () => { drag = null; canvas.style.cursor = ''; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('wheel', event => {
    const frame = activeTerrainFrame();
    if (spaceViewMode !== 'space' || !frame) return;
    event.preventDefault();
    const bounds = canvas.getBoundingClientRect();
    spaceView = zoomSpaceView(frame, spaceView, bounds.width, bounds.height, event.clientX - bounds.left, event.clientY - bounds.top, Math.exp(-event.deltaY * .0015));
    scheduleSpaceDraw();
  }, { passive: false });
  canvas.addEventListener('dblclick', () => {
    spaceView = { ...DEFAULT_SPACE_VIEW };
    scheduleSpaceDraw();
  });
  new ResizeObserver(scheduleSpaceDraw).observe(canvas);
}

attachOrbit($('#space-canvas'));
attachOrbit($('#space-window-canvas'));

function closeSpaceWindow() {
  spaceWindowOpen = false;
  $('#space-window').close();
  $('#space-canvas').classList.remove('detached');
  $('#space-detach').setAttribute('aria-pressed', 'false');
  scheduleSpaceDraw();
}

$('#space-detach').addEventListener('click', () => {
  if (spaceWindowOpen) { closeSpaceWindow(); return; }
  spaceWindowOpen = true;
  $('#space-window').show();
  $('#space-canvas').classList.add('detached');
  $('#space-detach').setAttribute('aria-pressed', 'true');
  scheduleSpaceDraw();
});

$('#space-window-close').addEventListener('click', closeSpaceWindow);
$('#space-window').addEventListener('cancel', event => { event.preventDefault(); closeSpaceWindow(); });

$('#space-window-header').addEventListener('pointerdown', event => {
  if (event.target.closest('button')) return;
  const windowElement = $('#space-window');
  const bounds = windowElement.getBoundingClientRect();
  const offset = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  const header = event.currentTarget;
  header.setPointerCapture(event.pointerId);
  const move = moveEvent => {
    windowElement.style.left = `${Math.max(0, Math.min(innerWidth - 80, moveEvent.clientX - offset.x))}px`;
    windowElement.style.top = `${Math.max(0, Math.min(innerHeight - 40, moveEvent.clientY - offset.y))}px`;
  };
  const stop = () => { header.removeEventListener('pointermove', move); header.removeEventListener('pointerup', stop); };
  header.addEventListener('pointermove', move);
  header.addEventListener('pointerup', stop);
});

function imageFileData(file) {
  if (file.size > MAXIMUM_BACKGROUND_IMAGE_BYTES) throw new Error('The image must be 20 MB or smaller.');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The image could not be read.'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('The selected file is not a supported image.'));
      image.onload = () => resolve({ dataUrl: reader.result, pixelWidth: image.naturalWidth, pixelHeight: image.naturalHeight });
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function syncImageSettingOutputs() {
  $('#image-background-rotation-value').textContent = `${Number($('#image-background-rotation').value)}°`;
  $('#image-background-opacity-value').textContent = `${Math.round(Number($('#image-background-opacity').value) * 100)}%`;
}

$('#image-background-button').addEventListener('click', async () => {
  if (imageBackground) {
    const confirmed = await requestConfirmation({
      title: 'Return to map mode?',
      message: 'Exit Image mode and return to the map? Placed points remain in their current positions.',
      confirmLabel: 'Return to map'
    });
    if (confirmed) setImageBackground(null, { transformGeometry: false });
    return;
  }
  $('#image-background-file').value = '';
  $('#image-background-file').click();
});

$('#replace-image-background').addEventListener('click', () => {
  $('#image-background-file').value = '';
  $('#image-background-file').click();
});

function defaultStructureSize() {
  return imageBackground
    ? Math.max(MINIMUM_INITIAL_STRUCTURE_SIZE_METRES, Math.min(DEFAULT_STRUCTURE_SIZE_METRES, imageBackground.widthMetres / 5))
    : DEFAULT_STRUCTURE_SIZE_METRES;
}

function setStructureCreationDefaults() {
  $('#structure-material').value = 'inherit';
}

$('#structure-menu-button').addEventListener('click', () => {
  closeImagePanel();
  structurePanelOpen = !structurePanelOpen;
  if (structurePanelOpen && !selectedStructure()) setStructureCreationDefaults();
  syncStructurePanel();
});

$('#create-structure').addEventListener('click', () => {
  const center = map.getCenter();
  const size = defaultStructureSize();
  const structure = {
    id: crypto.randomUUID(),
    center: { latitude: center.lat, longitude: center.lng },
    verticesMetres: createRectangleVertices(size, size),
    rotationDegrees: imageBackground?.rotationDegrees ?? 0,
    material: materialValues.has($('#structure-material').value) ? $('#structure-material').value : 'inherit'
  };
  state.structures.push(structure);
  selectedStructureId = structure.id;
  structurePanelOpen = true;
  setEchoFieldButtonDisabled(false);
  syncStructureGeometry();
  commitStructureGeometry();
});

function updateSelectedStructureFromPanel() {
  const structure = selectedStructure();
  if (!structure) return;
  structure.material = materialValues.has($('#structure-material').value) ? $('#structure-material').value : 'inherit';
  syncStructureGeometry();
  commitStructureGeometry();
}

$('#structure-material').addEventListener('change', updateSelectedStructureFromPanel);
$('#delete-structure').addEventListener('click', deleteSelectedStructure);
document.addEventListener('keydown', event => {
  if (!['Delete', 'Backspace'].includes(event.key) || !selectedStructure() || /INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) return;
  event.preventDefault();
  deleteSelectedStructure();
});

$('#image-background-file').addEventListener('change', async event => {
  const [file] = event.currentTarget.files;
  if (!file) return;
  const imageButton = $('#image-background-button');
  imageButton.setAttribute('aria-busy', 'true');
  try {
    const image = await imageFileData(file);
    const center = map.getCenter();
    const replacing = Boolean(imageBackground);
    const next = replacing ? { ...imageBackground, ...image, name: file.name } : {
      ...image, name: file.name,
      center: { latitude: center.lat, longitude: center.lng },
      widthMetres: IMAGE_WIDTH_RANGE.fallback, rotationDegrees: 0, opacity: IMAGE_OPACITY_RANGE.fallback
    };
    setImageBackground(next, { fit: !replacing });
  } catch (error) {
    window.alert(error.message);
  } finally {
    imageButton.removeAttribute('aria-busy');
  }
});

document.querySelectorAll('[data-image-panel]').forEach(button => button.addEventListener('click', () => openImagePanel(button.dataset.imagePanel)));

$('#image-background-rotation').addEventListener('input', event => {
  if (!imageBackground) return;
  const rotationDegrees = boundedValue(event.currentTarget.value, { minimum: -180, maximum: 180, fallback: 0 });
  setImageBackground({ ...imageBackground, rotationDegrees });
});

$('#image-background-opacity').addEventListener('input', event => {
  if (!imageBackground) return;
  const opacity = boundedValue(event.currentTarget.value, IMAGE_OPACITY_RANGE);
  setImageBackground({ ...imageBackground, opacity }, { transformGeometry: false });
});

$('#apply-image-scale').addEventListener('click', () => {
  if (!imageBackground || imageScalePoints.length !== 2) return;
  const currentDistance = distanceMetres(imageScalePoints[0], imageScalePoints[1]);
  const knownDistance = boundedValue($('#image-known-distance').value, { minimum: .1, maximum: 100000, fallback: currentDistance });
  if (!Number.isFinite(currentDistance) || currentDistance <= 0) return;
  const widthMetres = boundedValue(imageBackground.widthMetres * knownDistance / currentDistance, IMAGE_WIDTH_RANGE);
  setImageBackground({ ...imageBackground, widthMetres });
  closeImagePanel();
});

$('#clear-reflectors').addEventListener('click', async () => {
  const reflectionCount = audibleReflectors().length;
  if (!reflectionCount) return;
  const confirmed = await requestConfirmation({
    title: 'Clear reflection field?',
    message: `Remove all ${reflectionCount} reflectors and disable Echo field? This cannot be undone.`,
    confirmLabel: 'Clear reflectors'
  });
  if (!confirmed) return;
  if (echoFieldEnabled) setEchoFieldEnabled(false);
  state.reflectors = [];
  syncMarkers();
  render();
});

$('#global-level').addEventListener('input', event => {
  releaseSavedEchoField();
  const nextLevelDb = Number(event.currentTarget.value);
  const changeDb = nextLevelDb - state.globalReflectionLevelDb;
  state.globalReflectionLevelDb = nextLevelDb;
  state.reflectors.forEach(reflector => {
    reflector.levelDb = boundedValue((reflector.levelDb ?? nextLevelDb) + changeDb, REFLECTION_LEVEL_RANGE);
  });
  $('#global-level-value').textContent = `${nextLevelDb} dB`;
  updateReflectionLevels();
  scheduleEchoFieldUpdate();
  scheduleSave();
});

$('#global-material').addEventListener('change', event => {
  state.globalMaterial = event.currentTarget.value;
  scheduleSave();
});

function setBuildingLayerVisibility(visible) {
  BUILDING_LAYER_IDS.forEach(id => map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none'));
}

function addBuildingLayers() {
  if (map.getSource('overture-buildings')) return;
  map.addSource('overture-buildings', {
    type: 'vector',
    url: OVERTURE_BUILDINGS_URL,
    attribution: '© <a href="https://overturemaps.org/">Overture Maps Foundation</a>'
  });
  const layers = [
    ['overture-building-fill', 'buildings', 'fill', { 'fill-color': '#e8e8e8', 'fill-opacity': .2 }],
    ['overture-building-line', 'buildings', 'line', { 'line-color': '#c4c4c4', 'line-width': 1.2, 'line-opacity': .85 }]
  ];
  layers.forEach(([id, sourceLayer, type, paint]) => map.addLayer({ id, source: 'overture-buildings', 'source-layer': sourceLayer, type, minzoom: 14, paint }, 'direct-route'));
}

function setBuildingsLoading(loading) {
  const button = $('#buildings-button');
  button.disabled = loading || Boolean(imageBackground);
  if (loading) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
}

function monitorInitialBuildingLoad() {
  setBuildingsLoading(true);
  let finished = false;
  const timeoutId = setTimeout(() => finish(false), 20000);
  const finish = loaded => {
    if (finished) return;
    finished = true;
    clearTimeout(timeoutId);
    map.off('sourcedata', onSourceData);
    map.off('error', onError);
    setBuildingsLoading(false);
    $('#buildings-button').title = loaded ? 'Hide building data' : 'Building data could not be loaded';
    setEchoFieldButtonDisabled(!loaded && state.structures.length === 0);
    if (loaded) $('#echo-field-button').title = 'Create an automatic echo field around the Listener';
  };
  const onSourceData = event => {
    if (event.sourceId === 'overture-buildings' && event.isSourceLoaded) finish(true);
  };
  const onError = event => {
    if (event.sourceId === 'overture-buildings') finish(false);
  };
  map.on('sourcedata', onSourceData);
  map.on('error', onError);
}

$('#buildings-button').addEventListener('click', () => {
  if (!map.loaded() || imageBackground) return;
  const firstLoad = !map.getSource('overture-buildings');
  if (firstLoad) monitorInitialBuildingLoad();
  addBuildingLayers();
  state.buildingsVisible = !state.buildingsVisible;
  setBuildingLayerVisibility(state.buildingsVisible);
  if (!state.buildingsVisible) clearBuildingHover();
  const button = $('#buildings-button');
  button.setAttribute('aria-pressed', String(state.buildingsVisible));
  button.title = state.buildingsVisible ? 'Hide building data' : 'Load building data';
  setEchoFieldButtonDisabled((!state.buildingsVisible || firstLoad) && state.structures.length === 0);
  if (!state.buildingsVisible && echoFieldEnabled && state.structures.length === 0) setEchoFieldEnabled(false);
  if (state.buildingsVisible && map.getZoom() < 14) map.easeTo({ zoom: 14 });
});

function setEchoFieldEnabled(enabled, restoredReflectors = null) {
  echoFieldEnabled = enabled;
  const button = $('#echo-field-button');
  button.setAttribute('aria-pressed', String(enabled));
  if (enabled) {
    const element = document.createElement('div');
    element.className = 'echo-field-handle';
    element.setAttribute('aria-label', 'Echo field radius');
    const point = echoFieldHandlePoint();
    echoFieldHandle = new maplibregl.Marker({ element, draggable: true })
      .setLngLat([point.longitude, point.latitude]).addTo(map);
    const updateRadius = () => {
      releaseSavedEchoField();
      state.settings.echoFieldRadiusMetres = Math.max(MINIMUM_ECHO_FIELD_RADIUS_METRES, distanceMetres(state.mapPlacement.listener, pointFromLngLat(echoFieldHandle.getLngLat())));
      scheduleSave();
      syncEchoFieldGeometry();
      scheduleEchoFieldUpdate();
    };
    echoFieldHandle.on('drag', updateRadius);
    echoFieldHandle.on('dragend', updateRadius);
    syncEchoFieldGeometry();
    if (Array.isArray(restoredReflectors)) {
      echoFieldUsesSavedReflectors = true;
      setEchoFieldButtonDisabled(false);
      automaticReflectors = restoredReflectors;
      button.textContent = `Echo field · ${automaticReflectors.length}`;
      button.title = `${state.settings.echoFieldRadiusMetres.toFixed(0)} m radius · ${automaticReflectors.length} saved surfaces`;
      syncRoutes();
      render();
      clearTimeout(echoFieldUpdateTimer);
    } else rebuildEchoField();
  } else {
    echoFieldUsesSavedReflectors = false;
    clearTimeout(echoFieldUpdateTimer);
    echoFieldHandle?.remove();
    echoFieldHandle = null;
    automaticReflectors = [];
    button.textContent = 'Echo field';
    button.title = 'Create an automatic echo field around the Listener';
    setEchoFieldButtonDisabled(!hasEchoFieldWalls());
    syncEchoFieldGeometry();
    render();
  }
}

$('#echo-field-button').addEventListener('click', () => setEchoFieldEnabled(!echoFieldEnabled));

$('#link-points').addEventListener('click', () => {
  releaseSavedEchoField();
  const placement = activePlacement();
  placement.pointsLinked = !placement.pointsLinked;
  if (placement.pointsLinked) placement.listener = { ...placement.source };
  syncMarkers();
  render();
});

const SEARCH_CACHE_PREFIX = 'echotect-search:';
const SEARCH_INTERVAL_MILLISECONDS = 1000;

function readSearchCache(key) {
  try {
    const cached = sessionStorage.getItem(key);
    return cached ? JSON.parse(cached) : null;
  } catch {
    return null;
  }
}

function writeSearchCache(key, location) {
  try {
    sessionStorage.setItem(key, JSON.stringify(location));
  } catch {
  }
}

async function searchLocation(query) {
  const parsed = parseCoordinates(query);
  if (parsed) return { ...parsed, label: coordinateText(parsed) };
  const cacheKey = `${SEARCH_CACHE_PREFIX}${query.toLocaleLowerCase()}`;
  const cached = readSearchCache(cacheKey);
  if (cached) return cached;
  const wait = Math.max(0, SEARCH_INTERVAL_MILLISECONDS - (Date.now() - lastSearchAt));
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  lastSearchAt = Date.now();
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.search = new URLSearchParams({ q: query, format: 'jsonv2', limit: '1', 'accept-language': 'en' });
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('The place search service did not respond.');
  const [result] = await response.json();
  if (!result) return null;
  const location = { latitude: Number(result.lat), longitude: Number(result.lon), label: result.display_name };
  writeSearchCache(cacheKey, location);
  return location;
}

$('#search-form').addEventListener('submit', async event => {
  event.preventDefault();
  const input = $('#location-input');
  const query = input.value.trim();
  if (!query) return;
  input.setCustomValidity('');
  try {
    const location = await searchLocation(query);
    if (!location) {
      input.setCustomValidity('No matching place was found.');
      input.reportValidity();
      return;
    }
    map.flyTo({ center: [location.longitude, location.latitude], zoom: 16 });
  } catch (error) {
    input.setCustomValidity(error.message);
    input.reportValidity();
  }
});

$('#location-input').addEventListener('input', event => event.currentTarget.setCustomValidity(''));

$('#locate-button').addEventListener('click', () => {
  const input = $('#location-input');
  const button = $('#locate-button');
  input.setCustomValidity('');
  if (!navigator.geolocation) {
    input.setCustomValidity('Browser location is not available.');
    input.reportValidity();
    return;
  }

  button.disabled = true;
  navigator.geolocation.getCurrentPosition(position => {
    const location = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude
    };
    input.value = coordinateText(location);
    map.flyTo({ center: [location.longitude, location.latitude], zoom: 16 });
    button.disabled = false;
  }, error => {
    const messages = {
      1: 'Location permission was denied.',
      2: 'Your location is currently unavailable.',
      3: 'Location request timed out.'
    };
    input.setCustomValidity(messages[error.code] ?? 'Your location could not be determined.');
    input.reportValidity();
    button.disabled = false;
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
});

$('#listener-heading').addEventListener('input', event => {
  const heading = Number(event.currentTarget.value);
  state.settings.heading = heading;
  $('#heading-value').textContent = `${heading}°`;
  $('#heading-arrow').style.transform = `rotate(${heading}deg)`;
  scheduleSave();
});

$('#arrivals-only').addEventListener('change', event => {
  state.settings.arrivalsOnly = event.currentTarget.checked;
  scheduleSave();
});

$('#panning-mode').addEventListener('change', event => {
  state.settings.panningMode = event.currentTarget.value === 'spatial-stereo' ? 'spatial-stereo' : 'hrtf-live';
  scheduleSave();
});

function getAudioContext() {
  audioContext ??= new AudioContext();
  return audioContext;
}

const waitMilliseconds = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function withTimeout(promise, milliseconds, operation) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${operation} timed out.`)), milliseconds);
    })
  ]).finally(() => clearTimeout(timer));
}

async function audioClockAdvances(context) {
  if (context.state === 'closed') return false;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  gain.gain.value = 0;
  oscillator.connect(gain).connect(context.destination);
  const startedAt = context.currentTime;
  oscillator.start();
  try {
    await waitMilliseconds(AUDIO_RECOVERY_CLOCK_TEST_MS);
    return context.state === 'running'
      && context.currentTime - startedAt >= AUDIO_RECOVERY_MINIMUM_CLOCK_ADVANCE_SECONDS;
  } finally {
    try { oscillator.stop(); } catch { /* A failed context may already have discarded the source. */ }
    oscillator.disconnect();
    gain.disconnect();
  }
}

async function cycleAudioContext(context) {
  if (context.state === 'closed') return false;
  try {
    await withTimeout(context.suspend(), AUDIO_RECOVERY_OPERATION_TIMEOUT_MS, 'Audio suspend');
    await withTimeout(context.resume(), AUDIO_RECOVERY_OPERATION_TIMEOUT_MS, 'Audio resume');
    return await audioClockAdvances(context);
  } catch {
    return false;
  }
}

async function closeAudioContext(context) {
  if (!context || context.state === 'closed') return;
  try {
    await withTimeout(context.close(), AUDIO_RECOVERY_OPERATION_TIMEOUT_MS, 'Audio close');
  } catch {
    // A stuck WebKit audio process may never settle close(); recovery must still continue.
  }
}

async function loadDefaultHandclap(context) {
  if (!defaultHandclapBuffer) {
    const response = await fetch(new URL('../assets/handclap.wav', import.meta.url));
    if (!response.ok) throw new Error('The built-in handclap could not be loaded.');
    defaultHandclapBuffer = await context.decodeAudioData(await response.arrayBuffer());
  }
  return defaultHandclapBuffer;
}

function syncPlayButton() {
  const button = $('#play-button');
  if (!button) return;
  if (activePlayback) button.textContent = 'Stop';
  else if (renderingPlayback) button.textContent = 'Cancel';
  else if (state.settings.playbackMode === 'rendered') button.textContent = currentRender() ? 'Play render' : 'Render';
  else button.textContent = 'Play impulse';
  button.disabled = !renderingPlayback && !propagation().valid;
  if (renderingPlayback) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
}

function clearPlaybackProgress() {
  clearTimeout(playbackProgressTimer);
  playbackProgressTimer = null;
  $('#play-button').classList.remove('playing');
}

function startPlaybackProgress(durationSeconds, delaySeconds = 0) {
  clearPlaybackProgress();
  if (!(durationSeconds > 0)) return;
  const button = $('#play-button');
  button.style.setProperty('--playback-duration', `${durationSeconds}s`);
  button.style.setProperty('--playback-delay', `${Math.max(0, delaySeconds)}s`);
  void button.offsetWidth;
  button.classList.add('playing');
  playbackProgressTimer = setTimeout(clearPlaybackProgress, (Math.max(0, delaySeconds) + durationSeconds) * 1000);
}

function cutoffDurationSeconds(channels, sampleRate, inputMono) {
  let sourcePeak = 0;
  for (const sample of inputMono) sourcePeak = Math.max(sourcePeak, Math.abs(sample));
  if (!sourcePeak) return 0;
  const threshold = sourcePeak * 10 ** (state.settings.echoField.cutoffDb / 20);
  for (let frame = channels[0].length - 1; frame >= 0; frame -= 1) {
    if (channels.some(channel => Math.abs(channel[frame]) >= threshold)) return (frame + 1) / sampleRate;
  }
  return 0;
}

function hrtfMonitorDurationSeconds(data, context) {
  let duration = cutoffDurationSeconds(data.rendered.late, WAV_SAMPLE_RATE, data.inputMono);
  const inputFrames = data.inputMono.length;
  if (data.plan.playOnset) duration = Math.max(duration, inputFrames / context.sampleRate);
  const arrivals = [...data.earlyEvents];
  if (data.plan.playDirectArrival) arrivals.push(data.directArrival);
  for (const event of arrivals) {
    const filterFrames = event.filter?.length ?? 1;
    duration = Math.max(duration, (event.frame + inputFrames + filterFrames - 1) / context.sampleRate);
  }
  return duration;
}

function stopPlayback() {
  if (!activePlayback) return;
  const playback = activePlayback;
  activePlayback = null;
  playback.sources.forEach(source => {
    try { source.stop(); } catch { /* A source that has already ended needs no action. */ }
  });
  clearPlaybackProgress();
  clearReflectionPulses();
  syncPlayButton();
}

function beginPlayback(context, sources, startTime, durationSeconds) {
  stopPlayback();
  const delaySeconds = Math.max(0, startTime - context.currentTime);
  const playback = { context, sources, startTime, durationSeconds };
  activePlayback = playback;
  startPlaybackProgress(durationSeconds, delaySeconds);
  let remainingSources = sources.length;
  const sourceEnded = () => {
    remainingSources -= 1;
    if (remainingSources > 0 || activePlayback !== playback) return;
    activePlayback = null;
    clearPlaybackProgress();
    clearReflectionPulses();
    syncPlayButton();
  };
  sources.forEach(source => source.addEventListener('ended', sourceEnded, { once: true }));
  sources.forEach(source => source.stop(startTime + durationSeconds));
  syncPlayButton();
}

function invalidateRenderedPlayback() {
  renderedPlayback = null;
  syncPlayButton();
}

const playbackStartTime = context => context.currentTime + (context.baseLatency ?? 0) + (context.outputLatency ?? 0);

function releaseWhenFinished(source, nodes) {
  source.addEventListener('ended', () => nodes.forEach(node => node.disconnect()), { once: true });
}

function createRenderedSource(context, channels) {
  const source = context.createBufferSource();
  source.buffer = context.createBuffer(2, channels[0].length, WAV_SAMPLE_RATE);
  channels.forEach((channel, index) => source.buffer.copyToChannel(channel, index));
  source.connect(context.destination);
  releaseWhenFinished(source, [source]);
  return source;
}

function playRenderedChannels(context, channels, startTime = playbackStartTime(context)) {
  const source = createRenderedSource(context, channels);
  source.start(startTime);
  return source;
}

function clearReflectionPulses() {
  cancelAnimationFrame(reflectionPulseAnimationFrame);
  reflectionPulseAnimationFrame = null;
  const canvas = $('#reflection-pulses');
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  if (spacePulses.length) showSpacePulses([]);
}

function animateReflectionPulses(events, reflectors, lateEvents = [], durationSeconds = Infinity) {
  clearReflectionPulses();
  if (!events.length || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const pointsById = new Map(reflectors.map(reflector => [reflector.id, reflector]));
  const manualReflectorIds = new Set(visibleManualReflectors().map(reflector => reflector.id));
  const placement = propagation();
  const strongest = [...events]
    .sort((a, b) => b.levelDb - a.levelDb)
    .slice(0, MAXIMUM_VISUALIZED_PATHS);
  const pulses = [];
  for (const event of strongest) {
    let previous = placement.source;
    let delaySeconds = 0;
    for (let bounce = 0; bounce < event.reflectorIds.length; bounce += 1) {
      const point = pointsById.get(event.reflectorIds[bounce]);
      if (!point) continue;
      const fromPoint = previous;
      delaySeconds += placement.distanceMetres(previous, point) / soundSpeedMetresPerSecond(state.settings.echoField);
      previous = point;
      pulses.push({
        point,
        fromPoint,
        delaySeconds,
        manual: manualReflectorIds.has(point.id),
        levelDb: event.levelDb - 20 * Math.log10(1 + bounce * .06),
        maximumOpacity: .78
      });
      if (pulses.length >= MAXIMUM_REFLECTION_PULSES) break;
    }
    if (pulses.length >= MAXIMUM_REFLECTION_PULSES) break;
  }
  for (const event of lateEvents) {
    if (pulses.length >= MAXIMUM_REFLECTION_PULSES) break;
    const point = pointsById.get(event.reflectorId);
    if (!point) continue;
    pulses.push({
      point,
      fromPoint: pointsById.get(event.previousReflectorId) ?? activePlacement().source,
      delaySeconds: event.seconds,
      manual: manualReflectorIds.has(point.id),
      levelDb: event.levelDb,
      maximumOpacity: .58
    });
  }
  if (!pulses.length) return;
  pulses.sort((a, b) => a.delaySeconds - b.delaySeconds);
  const canvas = $('#reflection-pulses');
  const context = canvas.getContext('2d');
  const startedAt = performance.now();
  let firstActive = 0;
  const draw = now => {
    const pixelRatio = devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== Math.round(width * pixelRatio) || canvas.height !== Math.round(height * pixelRatio)) {
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
    }
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);
    const elapsed = (now - startedAt) / 1000;
    if (elapsed >= durationSeconds) {
      clearReflectionPulses();
      return;
    }
    while (firstActive < pulses.length && elapsed - pulses[firstActive].delaySeconds > .48) firstActive += 1;
    const activeByReflector = new Map();
    for (let index = firstActive; index < pulses.length; index += 1) {
      const pulse = pulses[index];
      const age = (elapsed - pulse.delaySeconds) / .48;
      if (age < 0) break;
      if (age > 1) continue;
      const center = map.project([pulse.point.longitude, pulse.point.latitude]);
      let position = center;
      if (pulse.manual && pulse.fromPoint) {
        const from = map.project([pulse.fromPoint.longitude, pulse.fromPoint.latitude]);
        const dx = center.x - from.x;
        const dy = center.y - from.y;
        const length = Math.hypot(dx, dy);
        if (length > 0) position = { x: center.x - dx / length * 11, y: center.y - dy / length * 11 };
      }
      const envelope = Math.sin(Math.PI * age);
      const energy = 10 ** (pulse.levelDb / 10) * envelope ** 2;
      const active = activeByReflector.get(pulse.point.id) ?? { energy: 0, maximumOpacity: 0, position, strongestEnergy: 0 };
      active.energy += energy;
      active.maximumOpacity = Math.max(active.maximumOpacity, pulse.maximumOpacity);
      if (energy > active.strongestEnergy) Object.assign(active, { position, strongestEnergy: energy });
      activeByReflector.set(pulse.point.id, active);
    }
    const lit = [];
    for (const [id, active] of activeByReflector) {
      const combinedLevelDb = 10 * Math.log10(Math.max(Number.MIN_VALUE, active.energy));
      const alpha = Math.max(0, Math.min(active.maximumOpacity, (combinedLevelDb + 90) / 90 * active.maximumOpacity));
      if (alpha <= 0) continue;
      context.beginPath();
      context.arc(active.position.x, active.position.y, 2.5, 0, Math.PI * 2);
      context.fillStyle = `rgba(255, 255, 255, ${alpha})`;
      context.fill();
      const positionMetres = pointsById.get(id)?.positionMetres;
      if (positionMetres) lit.push({ positionMetres, alpha });
    }
    if (state.terrainSpace) showSpacePulses(lit);
    if (firstActive < pulses.length) reflectionPulseAnimationFrame = requestAnimationFrame(draw);
    else clearReflectionPulses();
  };
  reflectionPulseAnimationFrame = requestAnimationFrame(draw);
}

const copyStereo = channels => channels.map(channel => channel.slice());

function playbackKey() {
  const placement = propagation();
  return JSON.stringify({
    audioSourceRevision, source: placement.source, listener: placement.listener, directOccluded: placement.directOccluded,
    reflectors: exportReflectors(), heading: state.settings.heading, echoField: renderSettings(),
    panningMode: state.settings.panningMode, arrivalsOnly: state.settings.arrivalsOnly
  });
}

function currentRender() {
  return renderedPlayback && renderedPlayback.key === playbackKey() ? renderedPlayback : null;
}

function monitorRenderKey(placement, reflectors, outputs) {
  return JSON.stringify({
    audioSourceRevision,
    source: placement.source,
    listener: placement.listener,
    directOccluded: placement.directOccluded,
    reflectors,
    heading: state.settings.heading,
    echoField: renderSettings(),
    outputs
  });
}

function changeAudioSource() {
  stopPlayback();
  audioSourceRevision += 1;
  monitorRenderCache = null;
  invalidateRenderedPlayback();
}

async function renderMonitorAudio(key, options) {
  if (monitorRenderCache?.key === key) return monitorRenderCache.rendered;
  const rendered = await renderExportAudio(options);
  monitorRenderCache = { key, rendered };
  return rendered;
}

function addSourceOnset(channels, inputMono) {
  const gain = SOURCE_ONSET_GAIN * Math.SQRT1_2;
  for (const channel of channels) {
    const frames = Math.min(inputMono.length, channel.length);
    for (let frame = 0; frame < frames; frame += 1) channel[frame] += inputMono[frame] * gain;
  }
}

function monoAudioBuffer(context, samples, sampleRate = WAV_SAMPLE_RATE) {
  const buffer = context.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(samples, 0);
  return buffer;
}

function createHrtfArrival(context, buffer, event) {
  const source = context.createBufferSource(); const gain = context.createGain();
  const position = event.spatial === false ? null : hrtfPosition(activePlacement().listener, event.emitter, state.settings.heading);
  source.buffer = buffer; gain.gain.value = event.gain;
  let tail = source;
  const nodes = [source, gain];
  if (event.filter) {
    const convolver = context.createConvolver();
    convolver.normalize = false;
    convolver.buffer = monoAudioBuffer(context, event.filter, context.sampleRate);
    source.connect(convolver);
    tail = convolver;
    gain.gain.value = 1;
    nodes.push(convolver);
  }
  tail.connect(gain);
  if (position) {
    const panner = context.createPanner();
    panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse'; panner.refDistance = 1; panner.maxDistance = 2; panner.rolloffFactor = 0;
    panner.positionX.value = position.x; panner.positionY.value = position.y; panner.positionZ.value = position.z;
    gain.connect(panner).connect(context.destination);
    nodes.push(panner);
  } else gain.connect(context.destination);
  releaseWhenFinished(source, nodes);
  return { source, frame: event.frame };
}

function playHrtfMonitor(context, inputMono, lateChannels, reflectors, directArrival, plan, earlyEvents = null, startTime = playbackStartTime(context)) {
  const inputBuffer = monoAudioBuffer(context, inputMono);
  const lateSource = createRenderedSource(context, lateChannels);
  const onset = plan.playOnset
    ? createHrtfArrival(context, inputBuffer, { frame: 0, gain: SOURCE_ONSET_GAIN * Math.SQRT1_2, spatial: false })
    : null;
  const placement = propagation();
  const arrivals = (earlyEvents ?? createEarlyArrivalEvents({
    source: placement.source, listener: placement.listener, reflectors, settings: renderSettings(),
    sampleRate: context.sampleRate, distanceMetres: placement.distanceMetres
  }))
    .map(event => createHrtfArrival(context, inputBuffer, event));
  if (plan.playDirectArrival) arrivals.push(createHrtfArrival(context, inputBuffer, directArrival));
  onset?.source.start(startTime);
  lateSource.start(startTime);
  arrivals.forEach(arrival => arrival.source.start(startTime + arrival.frame / context.sampleRate));
  return [lateSource, ...arrivals.map(arrival => arrival.source), ...(onset ? [onset.source] : [])];
}

async function monitorPlaybackData(context, renderedMode = false) {
  const inputMono = resampleToMono(importedAudioBuffer ?? await loadDefaultHandclap(context));
  const reflectors = exportReflectors();
  const placement = propagation();
  const settings = renderSettings();
  const hrtfMonitor = state.settings.panningMode === 'hrtf-live';
  const directArrival = createDirectArrivalEvent({
    source: placement.source, listener: placement.listener, settings,
    sampleRate: renderedMode ? WAV_SAMPLE_RATE : context.sampleRate,
    distanceMetres: placement.distanceMetres, occluded: placement.directOccluded
  });
  const earlyEvents = createEarlyArrivalEvents({
    source: placement.source, listener: placement.listener, reflectors, settings,
    sampleRate: renderedMode ? WAV_SAMPLE_RATE : context.sampleRate, distanceMetres: placement.distanceMetres
  });
  const plan = monitorArrivalPlan(directArrival, state.settings.arrivalsOnly);
  const outputs = hrtfMonitor ? ['late'] : plan.playDirectArrival ? ['wet'] : ['early', 'late'];
  const renderOptions = {
    source: placement.source, listener: placement.listener, reflectors, heading: state.settings.heading,
    settings: { ...settings, spatialAudio: true }, distanceMetres: placement.distanceMetres,
    directOccluded: placement.directOccluded, inputMono, outputs,
    earlyEvents: renderedMode ? earlyEvents : null,
    maximumVisualEvents: MAXIMUM_LATE_REFLECTION_PULSES
  };
  const rendered = await renderMonitorAudio(monitorRenderKey(placement, reflectors, outputs), renderOptions);
  return { inputMono, reflectors, hrtfMonitor, directArrival, earlyEvents, plan, rendered };
}

function spatialMonitorChannels({ inputMono, plan, rendered }) {
  const channels = copyStereo(rendered.wet ?? rendered.early);
  if (!rendered.wet) addStereo(channels, rendered.late);
  if (plan.playOnset) addSourceOnset(channels, inputMono);
  return channels;
}

async function renderHrtfChannels({ inputMono, rendered, reflectors, directArrival, plan, earlyEvents }) {
  const context = new OfflineAudioContext(2, rendered.late[0].length, WAV_SAMPLE_RATE);
  playHrtfMonitor(context, inputMono, rendered.late, reflectors, directArrival, plan, earlyEvents);
  const buffer = await context.startRendering();
  return [new Float32Array(buffer.getChannelData(0)), new Float32Array(buffer.getChannelData(1))];
}

async function renderedMonitorChannels(data) {
  return data.hrtfMonitor ? renderHrtfChannels(data) : spatialMonitorChannels(data);
}

function renderHrtfWet(inputMono, late) {
  const placement = propagation();
  const geometry = {
    source: placement.source, listener: placement.listener, settings: renderSettings(),
    sampleRate: WAV_SAMPLE_RATE, distanceMetres: placement.distanceMetres
  };
  const reflectors = exportReflectors();
  return renderHrtfChannels({
    inputMono, rendered: { late }, reflectors,
    directArrival: createDirectArrivalEvent({ ...geometry, occluded: placement.directOccluded }),
    earlyEvents: createEarlyArrivalEvents({ ...geometry, reflectors }),
    plan: { playOnset: false, playDirectArrival: true }
  });
}

$('#play-button').addEventListener('click', async () => {
  const button = $('#play-button');
  if (activePlayback) {
    stopPlayback();
    return;
  }
  if (renderingPlayback) {
    activeRender = null;
    renderingPlayback = false;
    syncPlayButton();
    return;
  }
  if (!propagation().valid) return;
  if (state.settings.playbackMode === 'rendered' && currentRender()) {
    const context = getAudioContext();
    await context.resume();
    const durationSeconds = cutoffDurationSeconds(renderedPlayback.channels, WAV_SAMPLE_RATE, renderedPlayback.inputMono);
    const startTime = playbackStartTime(context);
    const source = playRenderedChannels(context, renderedPlayback.channels, startTime);
    beginPlayback(context, [source], startTime, durationSeconds);
    animateReflectionPulses(renderedPlayback.earlyEvents, renderedPlayback.reflectors, renderedPlayback.reflectionEvents, durationSeconds);
    return;
  }
  const rendering = state.settings.playbackMode === 'rendered';
  const key = playbackKey();
  const render = {};
  activeRender = render;
  if (rendering) {
    renderingPlayback = true;
    syncPlayButton();
  } else {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  }
  await new Promise(resolve => requestAnimationFrame(resolve));
  try {
    const context = getAudioContext();
    await context.resume();
    const data = await monitorPlaybackData(context, rendering);
    if (key !== playbackKey() || activeRender !== render) return;
    if (rendering) {
      const channels = await renderedMonitorChannels(data);
      if (key === playbackKey() && activeRender === render) renderedPlayback = {
        key,
        channels,
        earlyEvents: data.earlyEvents,
        reflectionEvents: data.rendered.reflectionEvents ?? [],
        reflectors: data.reflectors,
        inputMono: data.inputMono
      };
    } else if (data.hrtfMonitor) {
      const durationSeconds = hrtfMonitorDurationSeconds(data, context);
      const startTime = playbackStartTime(context);
      const sources = playHrtfMonitor(context, data.inputMono, data.rendered.late, data.reflectors, data.directArrival, data.plan, data.earlyEvents, startTime);
      beginPlayback(context, sources, startTime, durationSeconds);
      animateReflectionPulses(data.earlyEvents, data.reflectors, data.rendered.reflectionEvents, durationSeconds);
    } else {
      const channels = spatialMonitorChannels(data);
      const durationSeconds = cutoffDurationSeconds(channels, WAV_SAMPLE_RATE, data.inputMono);
      const startTime = playbackStartTime(context);
      const source = playRenderedChannels(context, channels, startTime);
      beginPlayback(context, [source], startTime, durationSeconds);
      animateReflectionPulses(data.earlyEvents, data.reflectors, data.rendered.reflectionEvents, durationSeconds);
    }
  } catch (error) {
    if (error?.name !== 'AbortError') console.error(error);
  } finally {
    if (rendering && activeRender === render) renderingPlayback = false;
    if (activeRender === render) activeRender = null;
    syncPlayButton();
  }
});

const LIVE_PLAYBACK_MAXIMUM_SECONDS = 2;
let renderedForLongSound = false;

function setImportedAudio(buffer, name, airMetres = 0) {
  importedAudioBuffer = buffer;
  importedAudioName = name;
  importedAudioAirMetres = airMetres;
  state.settings.echoField = { ...state.settings.echoField, sourceAirMetres: airMetres };
  const long = (buffer?.duration ?? 0) > LIVE_PLAYBACK_MAXIMUM_SECONDS;
  if (long && state.settings.playbackMode === 'live') {
    state.settings.playbackMode = 'rendered';
    renderedForLongSound = true;
  } else if (!long && renderedForLongSound) {
    state.settings.playbackMode = 'live';
    renderedForLongSound = false;
  }
  changeAudioSource();
  renderGeometry();
}

function placeHandoff(handoff) {
  const next = handoffPlacement(handoff, terrainActive() ? activePlacement() : state.mapPlacement);
  const frame = terrainActive() ? activeTerrainFrame() : null;
  const inTerrain = frame && ['source', 'listener'].every(role => placePoint(frame, next[role], terrainHeightMetres(state.terrainSpace, role)).valid);
  if (terrainActive() && !inTerrain) setActiveSpace('map');
  const placement = activePlacement();
  releaseSavedEchoField();
  Object.assign(placement, { source: next.source, listener: next.listener, pointsLinked: false });
  if (placement === state.mapPlacement) state.mapPlacement.heightsMetres = placementHeights({ source: next.sourceHeightMetres, listener: next.listenerHeightMetres });
  syncMarkers();
  render();
  if (next.moved) {
    const longitudes = [next.source.longitude, next.listener.longitude];
    const latitudes = [next.source.latitude, next.listener.latitude];
    map.fitBounds([[Math.min(...longitudes), Math.min(...latitudes)], [Math.max(...longitudes), Math.max(...latitudes)]], { padding: 80, maxZoom: 16, duration: 0 });
  }
}

function useHandoff(handoff, buffer, label) {
  setImportedAudio(buffer, label, handoffAirMetres(handoff));
  $('#sound-name').textContent = `Sound: ${label}`;
  placeHandoff(handoff);
}

function handoffBuffer(handoff, samples) {
  const { channels, sampleRateHz } = handoff.audio;
  const frames = samples.length / channels;
  const buffer = getAudioContext().createBuffer(channels, frames, sampleRateHz);
  for (let channel = 0; channel < channels; channel += 1) {
    const data = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) data[frame] = samples[frame * channels + channel];
    buffer.copyToChannel(data, channel);
  }
  return buffer;
}

async function openSoundPackage(file) {
  const found = packagedHandoffs(unzipStored(new Uint8Array(await file.arrayBuffer())));
  if (!found.length) throw new Error('no sound handed over by a tect');
  const [{ handoff, wav }] = found;
  const buffer = await getAudioContext().decodeAudioData(wav.slice().buffer);
  useHandoff(handoff, buffer, `${handoff.name || handoff.audio.file} (${file.name})`);
}

$('#audio-file').addEventListener('change', async event => {
  const [file] = event.target.files;
  if (!file) return;
  try {
    if (/\.zip$/i.test(file.name) || file.type === 'application/zip') {
      await openSoundPackage(file);
      return;
    }
    setImportedAudio(await getAudioContext().decodeAudioData(await file.arrayBuffer()), file.name);
    $('#sound-name').textContent = `Sound: ${file.name}`;
  } catch (error) {
    setImportedAudio(null, null);
    $('#sound-name').textContent = `Sound: ${file.name} could not be opened${error?.message && !(error instanceof DOMException) ? `: ${error.message}` : ''}`;
  }
});

const TECT_ORIGINS = Object.freeze(['https://janne-s.github.io', 'http://127.0.0.1:8000', 'http://localhost:8000']);
window.addEventListener('message', event => {
  if (!TECT_ORIGINS.includes(event.origin) || !event.source || typeof event.data?.type !== 'string') return;
  const answer = message => event.source.postMessage(message, event.origin);
  if (event.data.type === TECT_MESSAGES.hello) { answer({ type: TECT_MESSAGES.ready }); return; }
  if (event.data.type !== TECT_MESSAGES.handoff) return;
  try {
    const { handoff, samples } = readHandoffMessage(event.data);
    if (handoff.kind !== 'sound') throw new Error(`a ${handoff.kind} cannot be used as a sound`);
    useHandoff(handoff, handoffBuffer(handoff, samples), `${handoff.name || 'Sound'} from ${handoff.producer.app || 'another tect'}`);
    answer({ type: TECT_MESSAGES.received, id: handoff.id });
  } catch (error) {
    answer({ type: TECT_MESSAGES.refused, reason: error instanceof Error ? error.message : String(error) });
  }
});
if (window.opener) window.opener.postMessage({ type: TECT_MESSAGES.ready }, '*');

$('#default-sound').addEventListener('click', () => {
  setImportedAudio(null, null);
  $('#audio-file').value = '';
  $('#sound-name').textContent = `Sound: ${DEFAULT_SOUND_NAME}`;
});

const EXPORT_OUTPUTS_BY_SELECTION = Object.freeze({
  convolution: ['convolutionIr'], fdn: ['fdnIr'], wet: ['wet'], hrtf: ['late'], stems: ['direct', 'early', 'late']
});
const exportSelectionInputs = () => [...document.querySelectorAll('input[name="export-item"]')];
const exportReflectors = () => audibleReflectors().map(reflector => ({
  ...reflector,
  levelDb: reflector.levelDb ?? state.globalReflectionLevelDb,
  effectiveMaterial: effectiveMaterial(reflector, state.globalMaterial)
}));
const inputDurationSeconds = () => importedAudioBuffer?.duration ?? defaultHandclapBuffer?.duration ?? DEFAULT_HANDCLAP_DURATION_SECONDS;
const safeFileStem = name => name.trim().toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'echotect-project';
const formatBytes = bytes => bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;

function currentWorkspaceProject() {
  const center = map.getCenter();
  return createWorkspaceProject({
    project: state.project,
    placements: { map: state.mapPlacement, terrain: state.terrainPlacements },
    activeSpace: state.activeSpace,
    reflectors: state.reflectors,
    automaticReflectors,
    terrainSpace: state.terrainSpace,
    structures: state.structures,
    globalReflectionLevelDb: state.globalReflectionLevelDb,
    globalMaterial: state.globalMaterial,
    settings: state.settings,
    echoFieldEnabled,
    background: imageBackground,
    mapView: { latitude: center.lat, longitude: center.lng, zoom: map.getZoom() }
  });
}

function currentManifest(projectName = state.project.name) {
  const placement = propagation();
  const terrain = terrainActive();
  return createProjectManifest({
    projectId: state.project.id, projectName, createdAt: state.project.createdAt,
    source: placement.source, listener: placement.listener, reflectors: exportReflectors(),
    globalReflectionLevelDb: state.globalReflectionLevelDb, globalMaterial: state.globalMaterial,
    pointsLinked: activePlacement().pointsLinked, heading: state.settings.heading,
    echoField: {
      enabled: terrain || echoFieldEnabled, radiusMetres: state.settings.echoFieldRadiusMetres,
      activeSurfaceCount: terrain ? audibleReflectors().length : automaticReflectors.length
    },
    echoFieldSettings: { ...renderSettings(), canonicalPanning: 'spatial-stereo', livePanningMode: state.settings.panningMode },
    inputName: importedAudioName ?? DEFAULT_SOUND_NAME, inputDurationSeconds: inputDurationSeconds(),
    terrainSpace: terrain ? state.terrainSpace : null, distanceMetres: placement.distanceMetres, directOccluded: placement.directOccluded
  });
}

function exportSizes() {
  const settings = renderSettings();
  const placement = propagation();
  const geometry = { source: placement.source, listener: placement.listener, distanceMetres: placement.distanceMetres };
  const { convolutionIrFrames, fdnIrFrames, timelineFrames } = exportFrameLayout({
    settings,
    earlyFrames: createEarlyArrivalEvents({ ...geometry, reflectors: exportReflectors(), settings }).map(event => event.frame + event.filter.length - 1),
    directFrame: (() => { const event = createDirectArrivalEvent({ ...geometry, settings, occluded: placement.directOccluded }); return event.frame + event.filter.length - 1; })(),
    inputFrames: Math.ceil(inputDurationSeconds() * WAV_SAMPLE_RATE)
  });
  return {
    manifest: new TextEncoder().encode(`${JSON.stringify(currentManifest(), null, 2)}\n`).length,
    convolution: wavByteLength(convolutionIrFrames),
    fdn: wavByteLength(fdnIrFrames),
    wet: wavByteLength(timelineFrames),
    hrtf: wavByteLength(timelineFrames),
    stems: wavByteLength(timelineFrames) * STEM_FILE_COUNT
  };
}

function updateExportSummary() {
  if (!propagation().valid) {
    Object.keys(EXPORT_OUTPUTS_BY_SELECTION).concat('manifest').forEach(key => { $(`#export-size-${key}`).textContent = ''; });
    $('#export-summary').textContent = 'Source and Listener must be inside the terrain.';
    $('#export-field-note').hidden = true;
    $('#export-submit').disabled = true;
    return;
  }
  const sizes = exportSizes();
  Object.entries(sizes).forEach(([key, bytes]) => { $(`#export-size-${key}`).textContent = formatBytes(bytes); });
  const selected = exportSelectionInputs().filter(input => input.checked).map(input => input.value);
  const fileCount = selected.reduce((count, value) => count + (value === 'stems' ? STEM_FILE_COUNT : 1), 0);
  const bytes = selected.reduce((sum, value) => sum + sizes[value], 0);
  $('#export-summary').textContent = selected.length ? `${fileCount} file${fileCount === 1 ? '' : 's'} · ≈ ${formatBytes(bytes)}${fileCount > 1 ? ' · ZIP' : ''}` : 'Select at least one export.';
  const fieldNote = $('#export-field-note');
  fieldNote.hidden = audibleReflectors().length >= 2;
  fieldNote.textContent = fieldNote.hidden ? '' : 'Late field will be silent: add at least two reflectors for recursive late reflections.';
  $('#export-submit').disabled = selected.length === 0;
}

$('#export-button').addEventListener('click', () => {
  $('#export-project-name').value = state.project.name;
  $('#export-error').hidden = true;
  updateExportSummary();
  $('#export-dialog').showModal();
  $('#export-dialog').focus({ preventScroll: true });
});
exportSelectionInputs().forEach(input => input.addEventListener('change', updateExportSummary));
$('#export-all').addEventListener('click', () => { exportSelectionInputs().forEach(input => { input.checked = true; }); updateExportSummary(); });

function downloadExport(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#save-project-button').addEventListener('click', () => {
  const project = currentWorkspaceProject();
  const data = `${JSON.stringify(project, null, 2)}\n`;
  downloadExport(`${safeFileStem(state.project.name)}.echotect-project.json`, data, 'application/json');
});

$('#open-project-button').addEventListener('click', () => $('#open-project-file').click());

$('#open-project-file').addEventListener('change', async event => {
  const [file] = event.currentTarget.files;
  event.currentTarget.value = '';
  if (!file) return;
  let opened;
  try {
    opened = parseWorkspaceProject(await file.text());
  } catch (error) {
    window.alert(error.message);
    return;
  }
  const confirmed = await requestConfirmation({
    title: 'Open project?',
    message: `Replace the current workspace with “${opened.project.name}”?`,
    confirmLabel: 'Open project'
  });
  if (!confirmed) return;
  if (echoFieldEnabled) setEchoFieldEnabled(false);
  clearTimeout(echoFieldUpdateTimer);
  Object.assign(state, {
    project: opened.project,
    activeSpace: opened.activeSpace,
    mapPlacement: opened.placements.map,
    terrainPlacements: opened.placements.terrain,
    reflectors: opened.reflectors,
    structures: opened.structures,
    terrainSpace: opened.terrainSpace,
    globalReflectionLevelDb: opened.globalReflectionLevelDb,
    globalMaterial: opened.globalMaterial,
    settings: { ...opened.settings, echoField: { ...opened.settings.echoField, sourceAirMetres: importedAudioAirMetres } }
  });
  monitorRenderCache = null;
  automaticReflectors = opened.automaticReflectors;
  canonicalTerrainField = null;
  terrainField = null;
  terrainRevision += 1;
  selectedStructureId = null;
  setImageBackground(null, { transformGeometry: false });
  syncTerrainLayers();
  syncTerrainHandles();
  syncTerrainControls();
  syncSpacePanel();
  syncWorkspaceControls();
  map.jumpTo({ center: [opened.mapView.longitude, opened.mapView.latitude], zoom: opened.mapView.zoom });
  syncMarkers();
  if (opened.background) setImageBackground(opened.background, { transformGeometry: false });
  if (opened.echoFieldEnabled) setEchoFieldEnabled(true, opened.automaticReflectors);
  else render();
  saveWorkspaceNow();
});

$('#export-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') { $('#export-dialog').close('cancel'); return; }
  const projectName = $('#export-project-name').value.trim();
  if (!projectName) { $('#export-project-name').reportValidity(); return; }
  const selected = new Set(exportSelectionInputs().filter(input => input.checked).map(input => input.value));
  if (!selected.size) return;
  const button = $('#export-submit'); const errorOutput = $('#export-error');
  button.disabled = true; button.setAttribute('aria-busy', 'true'); errorOutput.hidden = true;
  await new Promise(resolve => requestAnimationFrame(resolve));
  try {
    state.project.name = projectName; saveWorkspaceNow();
    if (!propagation().valid) throw new Error('Source and Listener must be inside the terrain.');
    if (terrainActive() && terrainBuildPending()) throw new Error('The terrain echo field is still being calculated. Export again in a moment.');
    if (terrainActive() && !terrainField?.valid) throw new Error('The terrain echo field could not be calculated.');
    const manifest = currentManifest(projectName);
    const validation = validateProjectManifest(manifest);
    if (!validation.valid) throw new Error(`Project manifest is invalid: ${validation.errors.join('; ')}`);
    const stem = safeFileStem(projectName); const files = [];
    if (selected.has('manifest')) files.push({ name: `${stem}.echotect.json`, data: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`) });
    const outputs = [...selected].flatMap(value => EXPORT_OUTPUTS_BY_SELECTION[value] ?? []);
    if (outputs.length) {
      const inputMono = resampleToMono(importedAudioBuffer ?? await loadDefaultHandclap(getAudioContext()));
      const placement = propagation();
      const audio = await renderExportAudio({
        source: placement.source, listener: placement.listener, reflectors: exportReflectors(), heading: state.settings.heading,
        settings: { ...renderSettings(), spatialAudio: true }, distanceMetres: placement.distanceMetres,
        directOccluded: placement.directOccluded, inputMono, outputs
      });
      const addWav = (suffix, channels) => files.push({ name: `${stem}-${suffix}.wav`, data: encodeFloat32Wav(channels) });
      if (selected.has('convolution')) addWav('ir-sampled-paths', audio.convolutionIr);
      if (selected.has('fdn')) addWav('ir-rendered-fdn', audio.fdnIr);
      if (selected.has('wet')) addWav('wet', audio.wet);
      if (selected.has('hrtf')) addWav('wet-hrtf', await renderHrtfWet(inputMono, audio.late));
      if (selected.has('stems')) { addWav('stem-direct', audio.direct); addWav('stem-early', audio.early); addWav('stem-late', audio.late); }
    }
    if (files.length === 1) downloadExport(files[0].name, files[0].data, files[0].name.endsWith('.json') ? 'application/json' : 'audio/wav');
    else downloadExport(`${stem}-exports.zip`, zipStore(files), 'application/zip');
    $('#export-dialog').close('export');
  } catch (error) {
    errorOutput.textContent = error instanceof Error ? error.message : String(error); errorOutput.hidden = false;
  } finally {
    button.disabled = false; button.removeAttribute('aria-busy');
  }
});

$('#reset-audio').addEventListener('click', async event => {
  const button = event.currentTarget;
  const previousContext = audioContext;
  stopPlayback();
  audioSourceRevision += 1;
  monitorRenderCache = null;
  defaultHandclapBuffer = null;
  invalidateRenderedPlayback();
  audioContext = null;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.setAttribute('aria-label', 'Recovering audio');
  button.textContent = '';

  let replacementContext = null;
  let resumeReplacement = null;
  const closePrevious = closeAudioContext(previousContext);
  try {
    // Create and resume synchronously from the click so Safari retains the user activation.
    replacementContext = new AudioContext();
    audioContext = replacementContext;
    resumeReplacement = replacementContext.resume();

    await closePrevious;
    try {
      await withTimeout(resumeReplacement, AUDIO_RECOVERY_OPERATION_TIMEOUT_MS, 'Audio resume');
    } catch {
      // The state and clock test below is authoritative; Safari promises can stall independently.
    }
    let recovered = await audioClockAdvances(replacementContext);
    if (!recovered) recovered = await cycleAudioContext(replacementContext);
    if (!recovered) throw new Error(`Audio clock did not recover (state: ${replacementContext.state}).`);
  } catch (error) {
    console.warn('Audio recovery failed.', error, {
      previousState: previousContext?.state,
      replacementState: replacementContext?.state
    });
    if (audioContext === replacementContext) audioContext = null;
    await closeAudioContext(replacementContext);
    window.alert('The browser audio engine could not be restarted. Open Echotect in a new window and try again.');
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.removeAttribute('aria-label');
    button.textContent = 'Recover audio';
  }
});

// Restore the controls only after the whole module has initialized.
syncWorkspaceControls();
