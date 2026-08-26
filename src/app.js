import { createDirectArrivalEvent, createEarlyArrivalEvents, monitorArrivalPlan } from './arrivals.js';
import { SOURCE_ONSET_GAIN } from './audio-model.js';
import { DEFAULT_ECHO_FIELD_SETTINGS, ECHO_FIELD_SETTINGS, normalizeEchoFieldSettings } from './echo-field-settings.js';
import { edgeKey, reflectionField, reflectorVisibilityGraph, wallReflectionCandidate } from './echo-geometry.js';
import { exportFrameLayout } from './export-layout.js';
import { distanceMetres, isValidCoordinate, metresPerDegreeLatitude, metresPerDegreeLongitude, parseCoordinates, reflectionMetrics, SPEED_OF_SOUND_METRES_PER_SECOND } from './geo.js';
import { IMAGE_OPACITY_RANGE, IMAGE_WIDTH_RANGE, imageCoordinates, transformImageEdge, transformImagePoint } from './image-background.js';
import { effectiveMaterial, MATERIAL_LABELS, normalizeFacadeMaterial } from './materials.js';
import { addStereo, renderExportAudio, resampleToMono } from './offline-export.js';
import { createProjectManifest, validateProjectManifest } from './project-manifest.js';
import { boundedValue } from './range.js';
import { hrtfPosition } from './spatial.js';
import { createWorkspaceProject, parseWorkspaceProject, REFLECTION_LEVEL_RANGE } from './workspace-project.js';
import { encodeFloat32Wav, wavByteLength, WAV_SAMPLE_RATE } from './wav.js';
import { zipStore } from './zip.js';

const OVERTURE_BUILDINGS_URL = 'pmtiles://https://data.source.coop/cholmes/overture/overture-buildings.pmtiles';
const ACCENT_COLOR = '#ff4fae';
const BUILDING_LAYER_IDS = ['overture-building-fill', 'overture-building-line'];
const MAP_VIEW_STORAGE_KEY = 'echotect:map-view:v1';
const WORKSPACE_STORAGE_KEY = 'echotect:workspace:v4';
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
const DEFAULT_PROJECT_NAME = 'Echotect Project';
const WORKSPACE_SAVE_DELAY_MS = 400;
const MAXIMUM_BACKGROUND_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_SOURCE_ID = 'echotect-background-image';
const IMAGE_LAYER_ID = 'echotect-background-image';
const IMAGE_SCALE_SOURCE_ID = 'echotect-image-scale';
const OSM_TILE_URLS = ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'];
const MAXIMUM_REFLECTION_PULSES = 4800;
const MAXIMUM_VISUALIZED_PATHS = 800;
const MAXIMUM_LATE_REFLECTION_PULSES = 4000;

const validEdge = edge => Array.isArray(edge) && edge.length === 2
  && edge.every(point => Array.isArray(point) && point.length >= 2 && point.every(Number.isFinite));

function storedMapView() {
  try {
    const view = JSON.parse(localStorage.getItem(MAP_VIEW_STORAGE_KEY));
    if (isValidCoordinate(view) && Number.isFinite(view.zoom) && view.zoom >= 0 && view.zoom <= MAXIMUM_ZOOM) return view;
  } catch {
    // A missing, blocked, or malformed local value should not prevent startup.
  }
  return { ...DEFAULT_MAP_VIEW };
}

const newProject = () => ({ id: crypto.randomUUID(), name: DEFAULT_PROJECT_NAME, createdAt: new Date().toISOString() });

function defaultWorkspace() {
  return {
    project: newProject(),
    source: { latitude: 60.16955, longitude: 24.9369 },
    listener: { latitude: 60.1707, longitude: 24.9410 },
    reflectors: [{ id: crypto.randomUUID(), latitude: 60.1721, longitude: 24.9384, levelDb: REFLECTION_LEVEL_RANGE.fallback, material: 'inherit' }],
    pointsLinked: false,
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

function storedWorkspace() {
  try {
    const saved = JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY));
    if (!isValidCoordinate(saved?.source) || !isValidCoordinate(saved?.listener) || !Array.isArray(saved?.reflectors)) return null;
    return {
      project: typeof saved.project?.id === 'string' && typeof saved.project?.name === 'string' && typeof saved.project?.createdAt === 'string'
        ? saved.project : newProject(),
      source: saved.source,
      listener: saved.listener,
      reflectors: saved.reflectors.filter(isValidCoordinate).map(reflector => ({
        id: typeof reflector.id === 'string' ? reflector.id : crypto.randomUUID(),
        latitude: reflector.latitude,
        longitude: reflector.longitude,
        levelDb: boundedValue(reflector.levelDb, REFLECTION_LEVEL_RANGE),
        material: materialValues.has(reflector.material) ? reflector.material : 'inherit',
        ...(validEdge(reflector.buildingEdge) ? { buildingEdge: reflector.buildingEdge } : {}),
        ...(typeof reflector.buildingId === 'string' || typeof reflector.buildingId === 'number' ? { buildingId: reflector.buildingId } : {}),
        ...(typeof reflector.facadeMaterial === 'string' ? { facadeMaterial: reflector.facadeMaterial } : {})
      })),
      pointsLinked: Boolean(saved.pointsLinked),
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
state.buildingsVisible = false;
let activeTool = null;
let audioContext;
let importedAudioBuffer = null;
let importedAudioName = null;
let defaultHandclapBuffer = null;
let audioSourceRevision = 0;
let monitorRenderCache = null;
let renderedPlayback = null;
let renderingPlayback = false;
let playbackRevision = 0;
let activePlayback = null;
let playbackProgressTimer = null;
let reflectionPulseAnimationFrame = null;
let lastSearchAt = 0;
let hoveredBuildingEdge = null;
let automaticReflectors = [];
let echoFieldEnabled = false;
let echoFieldUsesSavedReflectors = false;
let echoFieldHandle = null;
let echoFieldUpdateTimer = null;
let imageBackground = null;
let activeImagePanel = null;
let imageScalePoints = [];
let imageScaleCursor = null;
let renderedImageDataUrl = null;

const protocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);
const initialMapView = storedMapView();

const map = new maplibregl.Map({
  container: 'map',
  center: [initialMapView.longitude, initialMapView.latitude],
  zoom: initialMapView.zoom,
  style: {
    version: 8,
    sources: { osm: { type: 'raster', tiles: OSM_TILE_URLS, tileSize: 256, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' } },
    layers: [{
      id: 'osm',
      type: 'raster',
      source: 'osm',
      paint: {
        'raster-saturation': -1,
        'raster-contrast': .22,
        'raster-brightness-min': .02,
        'raster-brightness-max': .46
      }
    }]
  }
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }));

map.on('moveend', () => {
  const center = map.getCenter();
  try {
    localStorage.setItem(MAP_VIEW_STORAGE_KEY, JSON.stringify({
      longitude: center.lng,
      latitude: center.lat,
      zoom: map.getZoom()
    }));
  } catch {
    // The map remains usable when browser storage is unavailable.
  }
});

const markers = new Map();
const $ = selector => document.querySelector(selector);
const coordinateText = point => `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`;
const pointFromLngLat = lngLat => ({ latitude: lngLat.lat, longitude: lngLat.lng });

let workspaceSaveTimer = null;

/** Continuous interaction schedules a save; a save is only written once the interaction settles. */
function scheduleSave() {
  invalidateRenderedPlayback();
  clearTimeout(workspaceSaveTimer);
  workspaceSaveTimer = setTimeout(saveWorkspace, WORKSPACE_SAVE_DELAY_MS);
}

function saveWorkspaceNow() {
  clearTimeout(workspaceSaveTimer);
  saveWorkspace();
}

window.addEventListener('pagehide', saveWorkspaceNow);

function saveWorkspace() {
  try {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({
      source: state.source,
      project: state.project,
      listener: state.listener,
      reflectors: state.reflectors,
      pointsLinked: state.pointsLinked,
      globalReflectionLevelDb: state.globalReflectionLevelDb,
      globalMaterial: state.globalMaterial,
      settings: state.settings
    }));
  } catch {
    // The current session remains usable when browser storage is unavailable.
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
  syncPlayButton();
}

syncWorkspaceControls();

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
  if (state.pointsLinked) {
    createMarker('combined', 'combined', state.source, point => {
      releaseSavedEchoField();
      state.source = point;
      state.listener = { ...point };
      renderGeometry();
    });
  } else {
    createMarker('source', 'source', state.source, point => { releaseSavedEchoField(); state.source = point; renderGeometry(); });
    createMarker('listener', 'listener', state.listener, point => { releaseSavedEchoField(); state.listener = point; renderGeometry(); });
  }
  state.reflectors.forEach((reflector, index) => createMarker(reflector.id, 'reflector', reflector, point => {
    Object.assign(reflector, point);
    delete reflector.buildingEdge;
    delete reflector.buildingId;
    delete reflector.facadeMaterial;
    renderGeometry();
  }, String(index + 1)));
}

const audibleReflectors = () => [...state.reflectors, ...automaticReflectors];

function routeGeoJson() {
  return {
    type: 'FeatureCollection',
    features: audibleReflectors().map(reflector => ({
      type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [
        [state.source.longitude, state.source.latitude],
        [reflector.longitude, reflector.latitude],
        [state.listener.longitude, state.listener.latitude]
      ] }
    }))
  };
}

function directRouteGeoJson() {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: [
      [state.source.longitude, state.source.latitude],
      [state.listener.longitude, state.listener.latitude]
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
  if (!echoFieldEnabled) return { type: 'FeatureCollection', features: [] };
  const eastScale = metresPerDegreeLongitude(state.listener.latitude);
  const coordinates = Array.from({ length: ECHO_FIELD_CIRCLE_POINTS + 1 }, (_, index) => {
    const angle = index / ECHO_FIELD_CIRCLE_POINTS * Math.PI * 2;
    return [
      state.listener.longitude + Math.sin(angle) * state.settings.echoFieldRadiusMetres / eastScale,
      state.listener.latitude + Math.cos(angle) * state.settings.echoFieldRadiusMetres / metresPerDegreeLatitude()
    ];
  });
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coordinates] } };
}

function echoFieldHandlePoint() {
  return {
    latitude: state.listener.latitude,
    longitude: state.listener.longitude + state.settings.echoFieldRadiusMetres / metresPerDegreeLongitude(state.listener.latitude)
  };
}

function syncEchoFieldGeometry() {
  map.getSource('echo-field')?.setData(circleGeoJson());
  if (echoFieldEnabled && echoFieldHandle) {
    const point = echoFieldHandlePoint();
    echoFieldHandle.setLngLat([point.longitude, point.latitude]);
  }
}

function syncRoutes() {
  const source = map.getSource('routes');
  if (source) source.setData(routeGeoJson());
  const directSource = map.getSource('direct-route');
  if (directSource) directSource.setData(directRouteGeoJson());
  const edgeSource = map.getSource('building-reflector-edges');
  if (edgeSource) edgeSource.setData(buildingEdgesGeoJson());
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
  }, map.getLayer('direct-route') ? 'direct-route' : undefined);
  renderedImageDataUrl = imageBackground.dataUrl;
}

function syncImageModeControls() {
  const active = Boolean(imageBackground);
  const imageButton = $('#image-background-button');
  imageButton.setAttribute('aria-pressed', String(active));
  imageButton.textContent = 'Image';
  $('#image-editor').hidden = !active;
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
  $('#echo-field-button').disabled = active || !state.buildingsVisible;
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
  state.source = transformImagePoint(state.source, previous, next);
  state.listener = transformImagePoint(state.listener, previous, next);
  state.reflectors.forEach(reflector => {
    Object.assign(reflector, transformImagePoint(reflector, previous, next));
    if (reflector.buildingEdge) reflector.buildingEdge = transformImageEdge(reflector.buildingEdge, previous, next);
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

/** Card elements that change while the geometry or levels change, kept per reflector id. */
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
  $('#reflection-list').replaceChildren(...state.reflectors.map((reflector, index) => {
    const card = reflectionCard(reflector, index);
    reflectionCards.set(reflector.id, card);
    return card.element;
  }));
  $('#empty-reflections').hidden = audibleReflectors().length > 0;
}

function updateReflectionMetrics() {
  state.reflectors.forEach(reflector => {
    const card = reflectionCards.get(reflector.id);
    if (!card) return;
    const metrics = reflectionMetrics(state.source, state.listener, reflector);
    card.listenerLeg.textContent = formatDistance(metrics.listenerLegMetres);
    card.delay.textContent = `${metrics.propagationSeconds.toFixed(3)} s`;
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
  $('#link-points').setAttribute('aria-pressed', String(state.pointsLinked));
  $('.link-label').textContent = state.pointsLinked ? 'Unlink' : 'Link';
  const arrivalsOnly = $('#arrivals-only');
  // The reason belongs on the label as well, because that is what a pointer lands on.
  arrivalsOnly.closest('label').title = arrivalsOnly.title = state.pointsLinked
    ? 'Mute the source onset. Linked points share one place, so only the reflections remain.'
    : 'Mute the source onset and monitor only what arrives at the Listener.';
}

/** Moving geometry: routes, derived readouts, and a scheduled save. No card is rebuilt. */
function renderGeometry() {
  syncRoutes();
  updateReflectionMetrics();
  scheduleEchoFieldUpdate();
  scheduleSave();
}

/** A changed reflector set, link state, or project: rebuild the cards, then update the geometry. */
function render() {
  syncLinkControls();
  renderReflectionList();
  renderGeometry();
}

map.on('load', () => {
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
  syncImageLayer();
  syncImageModeControls();
  syncMarkers(); render();
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
  if (!echoFieldEnabled || !map.getSource('overture-buildings')) return;
  echoFieldUsesSavedReflectors = false;
  const walls = [];
  const seenEdges = new Set();
  map.querySourceFeatures('overture-buildings', { sourceLayer: 'buildings' }).forEach(feature => {
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
        walls.push({ edge, key, ring, facadeMaterial });
      }
    });
  });
  const field = reflectionField({
    source: state.source, listener: state.listener, walls, radiusMetres: state.settings.echoFieldRadiusMetres
  });
  const candidates = walls.flatMap(wall => {
    const reflection = wallReflectionCandidate(field, wall, distanceMetres);
    if (!reflection) return [];
    const pathMetres = reflectionMetrics(state.source, state.listener, reflection.point).pathMetres;
    return [{
      id: `area-${wall.key}`,
      ...reflection.point,
      buildingEdge: wall.edge,
      facadeMaterial: wall.facadeMaterial,
      material: normalizeFacadeMaterial(wall.facadeMaterial) ?? 'inherit',
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
  if (!echoFieldEnabled || echoFieldUsesSavedReflectors) return;
  clearTimeout(echoFieldUpdateTimer);
  echoFieldUpdateTimer = setTimeout(rebuildEchoField, 80);
}

map.on('mousemove', event => {
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

map.on('mouseout', clearBuildingHover);

map.on('click', event => {
  if (activeImagePanel === 'scale' && imageBackground) {
    const point = pointFromLngLat(event.lngLat);
    imageScalePoints = imageScalePoints.length < 2 ? [...imageScalePoints, point] : [point];
    imageScaleCursor = null;
    syncImageScaleGuide();
    return;
  }
  if (!activeTool) return;
  const point = pointFromLngLat(event.lngLat);
  if (activeTool === 'source') {
    releaseSavedEchoField();
    state.source = point;
    if (state.pointsLinked) state.listener = { ...point };
  }
  if (activeTool === 'listener') {
    releaseSavedEchoField();
    state.listener = point;
    if (state.pointsLinked) state.source = { ...point };
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
      ...(wall ? { buildingEdge: wall.edge, buildingId: building.id, facadeMaterial } : {})
    });
  }
  syncMarkers(); render();
});

document.querySelectorAll('[data-tool]').forEach(button => button.addEventListener('click', () => {
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

$('#echo-settings-button').addEventListener('click', () => {
  $('#setting-playback-mode').value = state.settings.playbackMode;
  $('#setting-building-occlusion').checked = state.settings.echoField.buildingOcclusion;
  $('#setting-late-mode').value = state.settings.echoField.lateMode;
  $('#setting-point-mode').value = state.settings.echoField.pointMode;
  $('#setting-air-mode').value = state.settings.echoField.airMode;
  Object.entries(echoSettingInputs).forEach(([setting, selector]) => {
    $(selector).value = state.settings.echoField[setting];
    syncEchoSettingOutput(setting);
  });
  syncLateModeSettings();
  syncPointModeSettings();
  syncAirModeSettings();
  const dialog = $('#echo-settings-dialog');
  dialog.returnValue = 'cancel';
  dialog.showModal();
  dialog.focus({ preventScroll: true });
});

$('#echo-settings-dialog').addEventListener('close', event => {
  if (event.currentTarget.returnValue !== 'save') return;
  state.settings.playbackMode = $('#setting-playback-mode').value === 'rendered' ? 'rendered' : 'live';
  state.settings.echoField = normalizeEchoFieldSettings({
    ...Object.fromEntries(Object.keys(echoSettingInputs).map(setting => [setting, $(echoSettingInputs[setting]).value])),
    lateMode: $('#setting-late-mode').value,
    pointMode: $('#setting-point-mode').value,
    airMode: $('#setting-air-mode').value,
    buildingOcclusion: $('#setting-building-occlusion').checked
  });
  scheduleSave();
  syncPlayButton();
  if (echoFieldEnabled) rebuildEchoField();
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
    $('#echo-field-button').disabled = Boolean(imageBackground) || !loaded;
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
  $('#echo-field-button').disabled = !state.buildingsVisible || firstLoad;
  if (!state.buildingsVisible && echoFieldEnabled) setEchoFieldEnabled(false);
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
      state.settings.echoFieldRadiusMetres = Math.max(MINIMUM_ECHO_FIELD_RADIUS_METRES, distanceMetres(state.listener, pointFromLngLat(echoFieldHandle.getLngLat())));
      scheduleSave();
      syncEchoFieldGeometry();
      scheduleEchoFieldUpdate();
    };
    echoFieldHandle.on('drag', updateRadius);
    echoFieldHandle.on('dragend', updateRadius);
    syncEchoFieldGeometry();
    if (Array.isArray(restoredReflectors)) {
      echoFieldUsesSavedReflectors = true;
      button.disabled = false;
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
    button.disabled = !state.buildingsVisible;
    syncEchoFieldGeometry();
    render();
  }
}

$('#echo-field-button').addEventListener('click', () => setEchoFieldEnabled(!echoFieldEnabled));

$('#link-points').addEventListener('click', () => {
  releaseSavedEchoField();
  state.pointsLinked = !state.pointsLinked;
  if (state.pointsLinked) state.listener = { ...state.source };
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
    // Searching still works without a session cache.
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
  else if (renderingPlayback) button.textContent = 'Rendering…';
  else if (state.settings.playbackMode === 'rendered') button.textContent = renderedPlayback ? 'Play render' : 'Render';
  else button.textContent = 'Play impulse';
  button.disabled = renderingPlayback;
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

/** Finds the last sample above the path cutoff relative to the unchanged source, ignoring filter residue below it. */
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
  playbackRevision += 1;
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
}

function animateReflectionPulses(events, reflectors, lateEvents = [], durationSeconds = Infinity) {
  clearReflectionPulses();
  if (!events.length || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const pointsById = new Map(reflectors.map(reflector => [reflector.id, reflector]));
  const manualReflectorIds = new Set(state.reflectors.map(reflector => reflector.id));
  const strongest = [...events]
    .sort((a, b) => b.levelDb - a.levelDb)
    .slice(0, MAXIMUM_VISUALIZED_PATHS);
  const pulses = [];
  const seen = new Set();
  for (const event of strongest) {
    let previous = state.source;
    let delaySeconds = 0;
    for (let bounce = 0; bounce < event.reflectorIds.length; bounce += 1) {
      const point = pointsById.get(event.reflectorIds[bounce]);
      if (!point) continue;
      const fromPoint = previous;
      delaySeconds += distanceMetres(previous, point) / SPEED_OF_SOUND_METRES_PER_SECOND;
      const key = `${point.id}:${Math.round(delaySeconds * 30)}`;
      previous = point;
      if (seen.has(key)) continue;
      seen.add(key);
      pulses.push({
        point,
        fromPoint,
        delaySeconds,
        manual: manualReflectorIds.has(point.id),
        opacity: Math.max(.18, Math.min(.78, .18 + (event.levelDb + 90) / 120)) / (1 + bounce * .06)
      });
      if (pulses.length >= MAXIMUM_REFLECTION_PULSES) break;
    }
    if (pulses.length >= MAXIMUM_REFLECTION_PULSES) break;
  }
  for (const event of lateEvents) {
    if (pulses.length >= MAXIMUM_REFLECTION_PULSES) break;
    const point = pointsById.get(event.reflectorId);
    if (!point) continue;
    const key = `${point.id}:${Math.round(event.seconds * 30)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pulses.push({
      point,
      fromPoint: pointsById.get(event.previousReflectorId) ?? state.source,
      delaySeconds: event.seconds,
      manual: manualReflectorIds.has(point.id),
      opacity: Math.max(.12, Math.min(.58, .12 + (event.levelDb + 90) / 170))
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
      const alpha = Math.sin(Math.PI * age) * pulse.opacity;
      context.beginPath();
      context.arc(position.x, position.y, 2.5, 0, Math.PI * 2);
      context.fillStyle = `rgba(255, 255, 255, ${alpha})`;
      context.fill();
    }
    if (firstActive < pulses.length) reflectionPulseAnimationFrame = requestAnimationFrame(draw);
    else clearReflectionPulses();
  };
  reflectionPulseAnimationFrame = requestAnimationFrame(draw);
}

const copyStereo = channels => channels.map(channel => channel.slice());

function monitorRenderKey(reflectors, outputs) {
  return JSON.stringify({
    audioSourceRevision,
    source: state.source,
    listener: state.listener,
    reflectors,
    heading: state.settings.heading,
    echoField: state.settings.echoField,
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

/** Mixes the source onset trigger into a rendered monitor mix that the caller owns. */
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
  const position = event.spatial === false ? null : hrtfPosition(state.listener, event.emitter, state.settings.heading);
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
  const arrivals = (earlyEvents ?? createEarlyArrivalEvents({
    source: state.source, listener: state.listener, reflectors, settings: state.settings.echoField, sampleRate: context.sampleRate
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
  const hrtfMonitor = state.settings.panningMode === 'hrtf-live';
  const directArrival = createDirectArrivalEvent({
    source: state.source, listener: state.listener, settings: state.settings.echoField,
    sampleRate: renderedMode ? WAV_SAMPLE_RATE : context.sampleRate
  });
  const earlyEvents = createEarlyArrivalEvents({
    source: state.source, listener: state.listener, reflectors, settings: state.settings.echoField,
    sampleRate: renderedMode ? WAV_SAMPLE_RATE : context.sampleRate
  });
  const plan = monitorArrivalPlan(directArrival, state.settings.arrivalsOnly);
  const outputs = hrtfMonitor ? ['late'] : plan.playDirectArrival ? ['wet'] : ['early', 'late'];
  const renderOptions = {
    source: state.source, listener: state.listener, reflectors, heading: state.settings.heading,
    settings: { ...state.settings.echoField, spatialAudio: true }, distanceMetres, inputMono, outputs,
    earlyEvents: renderedMode ? earlyEvents : null,
    maximumVisualEvents: MAXIMUM_LATE_REFLECTION_PULSES
  };
  const rendered = await renderMonitorAudio(monitorRenderKey(reflectors, outputs), renderOptions);
  return { inputMono, reflectors, hrtfMonitor, directArrival, earlyEvents, plan, rendered };
}

function spatialMonitorChannels({ inputMono, plan, rendered }) {
  const channels = copyStereo(rendered.wet ?? rendered.early);
  if (!rendered.wet) addStereo(channels, rendered.late);
  if (plan.playOnset) addSourceOnset(channels, inputMono);
  return channels;
}

async function renderedMonitorChannels(data) {
  if (!data.hrtfMonitor) return spatialMonitorChannels(data);
  const frameCount = data.rendered.late[0].length;
  const context = new OfflineAudioContext(2, frameCount, WAV_SAMPLE_RATE);
  playHrtfMonitor(context, data.inputMono, data.rendered.late, data.reflectors, data.directArrival, data.plan, data.earlyEvents);
  const buffer = await context.startRendering();
  return [new Float32Array(buffer.getChannelData(0)), new Float32Array(buffer.getChannelData(1))];
}

$('#play-button').addEventListener('click', async () => {
  const button = $('#play-button');
  if (activePlayback) {
    stopPlayback();
    return;
  }
  if (state.settings.playbackMode === 'rendered' && renderedPlayback) {
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
  const revision = playbackRevision;
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
    if (rendering) {
      const channels = await renderedMonitorChannels(data);
      if (revision === playbackRevision) renderedPlayback = {
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
    if (rendering) renderingPlayback = false;
    syncPlayButton();
  }
});

$('#audio-file').addEventListener('change', async event => {
  const [file] = event.target.files;
  if (!file) return;
  try {
    const context = getAudioContext();
    importedAudioBuffer = await context.decodeAudioData(await file.arrayBuffer());
    importedAudioName = file.name;
    changeAudioSource();
    $('#sound-name').textContent = `Sound: ${file.name}`;
  } catch {
    importedAudioBuffer = null;
    importedAudioName = null;
    changeAudioSource();
    $('#sound-name').textContent = 'Sound: file could not be opened';
  }
});

$('#default-sound').addEventListener('click', () => {
  importedAudioBuffer = null;
  importedAudioName = null;
  changeAudioSource();
  $('#audio-file').value = '';
  $('#sound-name').textContent = `Sound: ${DEFAULT_SOUND_NAME}`;
});

const EXPORT_OUTPUTS_BY_SELECTION = Object.freeze({
  convolution: ['convolutionIr'], fdn: ['fdnIr'], wet: ['wet'], stems: ['direct', 'early', 'late']
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
    source: state.source,
    listener: state.listener,
    reflectors: state.reflectors,
    automaticReflectors,
    pointsLinked: state.pointsLinked,
    globalReflectionLevelDb: state.globalReflectionLevelDb,
    globalMaterial: state.globalMaterial,
    settings: state.settings,
    echoFieldEnabled,
    background: imageBackground,
    mapView: { latitude: center.lat, longitude: center.lng, zoom: map.getZoom() }
  });
}

function currentManifest(projectName = state.project.name) {
  return createProjectManifest({
    projectId: state.project.id, projectName, createdAt: state.project.createdAt,
    source: state.source, listener: state.listener, reflectors: exportReflectors(),
    globalReflectionLevelDb: state.globalReflectionLevelDb, globalMaterial: state.globalMaterial,
    pointsLinked: state.pointsLinked, heading: state.settings.heading,
    echoField: { enabled: echoFieldEnabled, radiusMetres: state.settings.echoFieldRadiusMetres, activeSurfaceCount: automaticReflectors.length },
    echoFieldSettings: { ...state.settings.echoField, canonicalPanning: 'spatial-stereo', livePanningMode: state.settings.panningMode },
    inputName: importedAudioName ?? DEFAULT_SOUND_NAME, inputDurationSeconds: inputDurationSeconds()
  });
}

function exportSizes() {
  const settings = state.settings.echoField;
  const geometry = { source: state.source, listener: state.listener };
  const { convolutionIrFrames, fdnIrFrames, timelineFrames } = exportFrameLayout({
    settings,
    earlyFrames: createEarlyArrivalEvents({ ...geometry, reflectors: exportReflectors(), settings }).map(event => event.frame + event.filter.length - 1),
    directFrame: (() => { const event = createDirectArrivalEvent({ ...geometry, settings }); return event.frame + event.filter.length - 1; })(),
    inputFrames: Math.ceil(inputDurationSeconds() * WAV_SAMPLE_RATE)
  });
  return {
    manifest: new TextEncoder().encode(`${JSON.stringify(currentManifest(), null, 2)}\n`).length,
    convolution: wavByteLength(convolutionIrFrames),
    fdn: wavByteLength(fdnIrFrames),
    wet: wavByteLength(timelineFrames),
    stems: wavByteLength(timelineFrames) * STEM_FILE_COUNT
  };
}

function updateExportSummary() {
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
    source: opened.source,
    listener: opened.listener,
    reflectors: opened.reflectors,
    pointsLinked: opened.pointsLinked,
    globalReflectionLevelDb: opened.globalReflectionLevelDb,
    globalMaterial: opened.globalMaterial,
    settings: opened.settings
  });
  monitorRenderCache = null;
  automaticReflectors = [];
  setImageBackground(null, { transformGeometry: false });
  syncWorkspaceControls();
  map.jumpTo({ center: [opened.mapView.longitude, opened.mapView.latitude], zoom: opened.mapView.zoom });
  syncMarkers();
  if (opened.background) setImageBackground(opened.background, { transformGeometry: false });
  if (opened.echoFieldEnabled && !opened.background) setEchoFieldEnabled(true, opened.automaticReflectors);
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
    const manifest = currentManifest(projectName);
    const validation = validateProjectManifest(manifest);
    if (!validation.valid) throw new Error(`Project manifest is invalid: ${validation.errors.join('; ')}`);
    const stem = safeFileStem(projectName); const files = [];
    if (selected.has('manifest')) files.push({ name: `${stem}.echotect.json`, data: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`) });
    const outputs = [...selected].flatMap(value => EXPORT_OUTPUTS_BY_SELECTION[value] ?? []);
    if (outputs.length) {
      const inputMono = resampleToMono(importedAudioBuffer ?? await loadDefaultHandclap(getAudioContext()));
      const audio = await renderExportAudio({ source: state.source, listener: state.listener, reflectors: exportReflectors(), heading: state.settings.heading, settings: { ...state.settings.echoField, spatialAudio: true }, distanceMetres, inputMono, outputs });
      const addWav = (suffix, channels) => files.push({ name: `${stem}-${suffix}.wav`, data: encodeFloat32Wav(channels) });
      if (selected.has('convolution')) addWav('ir-sampled-paths', audio.convolutionIr);
      if (selected.has('fdn')) addWav('ir-rendered-fdn', audio.fdnIr);
      if (selected.has('wet')) addWav('wet', audio.wet);
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
  const context = audioContext;
  stopPlayback();
  audioContext = null;
  if (!context || context.state === 'closed') return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    await context.close();
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
});
