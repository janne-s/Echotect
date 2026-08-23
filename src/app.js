import { directSoundMetrics, distanceMetres, hasDistinctDirectArrival, parseCoordinates, reflectionMetrics, reflectionPathMetrics } from './geo.js';
import { buildReflectionPaths, gainToDecibels, reflectionPathGain } from './audio-model.js';
import { hrtfPosition } from './spatial.js';
import { effectiveMaterial, MATERIAL_ATTENUATION_DB, MATERIAL_LABELS, normalizeFacadeMaterial } from './materials.js';
import { edgeKey, wallReflectionCandidate } from './echo-geometry.js';
import { createFdnConfiguration } from './fdn.js';

const OVERTURE_BUILDINGS_URL = 'pmtiles://https://data.source.coop/cholmes/overture/overture-buildings.pmtiles';
const ACCENT_COLOR = '#ff4fae';
const BUILDING_LAYER_IDS = ['overture-building-fill', 'overture-building-line'];
const MAP_VIEW_STORAGE_KEY = 'echotect:map-view:v1';
const WORKSPACE_STORAGE_KEY = 'echotect:workspace:v1';
const materialValues = new Set(Object.keys(MATERIAL_LABELS));
const DEFAULT_ECHO_FIELD_SETTINGS = Object.freeze({
  durationSeconds: 10,
  maxSurfaces: 48,
  earlyPathLimit: 512,
  lateWalks: 8192,
  maxBounces: 32,
  cutoffDb: -90,
  tailPersistence: .6,
  lateMode: 'convolution',
  fdnTailSeconds: 8,
  fdnDensity: .7,
  fdnDamping: .55,
  geometryInfluence: .7
});
const clamp = (value, minimum, maximum, fallback) => Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : fallback));

const validPoint = point => Number.isFinite(point?.latitude) && point.latitude >= -90 && point.latitude <= 90
  && Number.isFinite(point?.longitude) && point.longitude >= -180 && point.longitude <= 180;
const validEdge = edge => Array.isArray(edge) && edge.length === 2
  && edge.every(point => Array.isArray(point) && point.length >= 2 && point.every(Number.isFinite));

function storedMapView() {
  try {
    const view = JSON.parse(localStorage.getItem(MAP_VIEW_STORAGE_KEY));
    if (
      Number.isFinite(view?.longitude) && view.longitude >= -180 && view.longitude <= 180
      && Number.isFinite(view?.latitude) && view.latitude >= -90 && view.latitude <= 90
      && Number.isFinite(view?.zoom) && view.zoom >= 0 && view.zoom <= 24
    ) return view;
  } catch {
    // A missing, blocked, or malformed local value should not prevent startup.
  }
  return { longitude: 24.939, latitude: 60.1706, zoom: 15 };
}

const initial = {
  source: { latitude: 60.16955, longitude: 24.9369 },
  listener: { latitude: 60.1707, longitude: 24.9410 },
  reflectors: [{ id: crypto.randomUUID(), latitude: 60.1721, longitude: 24.9384 }]
};

function storedWorkspace() {
  try {
    const saved = JSON.parse(localStorage.getItem(WORKSPACE_STORAGE_KEY));
    if (!validPoint(saved?.source) || !validPoint(saved?.listener) || !Array.isArray(saved?.reflectors)) return null;
    return {
      source: saved.source,
      listener: saved.listener,
      reflectors: saved.reflectors.filter(validPoint).map(reflector => ({
        id: typeof reflector.id === 'string' ? reflector.id : crypto.randomUUID(),
        latitude: reflector.latitude,
        longitude: reflector.longitude,
        levelDb: Math.max(-18, Math.min(-1, Number.isFinite(reflector.levelDb) ? reflector.levelDb : -6)),
        material: materialValues.has(reflector.material) ? reflector.material : 'inherit',
        ...(validEdge(reflector.buildingEdge) ? { buildingEdge: reflector.buildingEdge } : {}),
        ...(typeof reflector.buildingId === 'string' || typeof reflector.buildingId === 'number' ? { buildingId: reflector.buildingId } : {}),
        ...(typeof reflector.facadeMaterial === 'string' ? { facadeMaterial: reflector.facadeMaterial } : {})
      })),
      pointsLinked: Boolean(saved.pointsLinked),
      globalReflectionLevelDb: Math.max(-18, Math.min(-1, Number.isFinite(saved.globalReflectionLevelDb) ? saved.globalReflectionLevelDb : -6)),
      globalMaterial: materialValues.has(saved.globalMaterial) && saved.globalMaterial !== 'inherit' ? saved.globalMaterial : 'generic',
      settings: {
        heading: Math.max(0, Math.min(359, Number.isFinite(saved.settings?.heading) ? saved.settings.heading : 0)),
        reflectionsSolo: Boolean(saved.settings?.reflectionsSolo),
        spatialAudio: saved.settings?.spatialAudio !== false,
        echoAreaRadiusMetres: Math.max(10, Number.isFinite(saved.settings?.echoAreaRadiusMetres) ? saved.settings.echoAreaRadiusMetres : 100),
        echoField: {
          durationSeconds: clamp(saved.settings?.echoField?.durationSeconds, 1, 30, DEFAULT_ECHO_FIELD_SETTINGS.durationSeconds),
          maxSurfaces: Math.round(clamp(saved.settings?.echoField?.maxSurfaces, 8, 256, DEFAULT_ECHO_FIELD_SETTINGS.maxSurfaces)),
          earlyPathLimit: Math.round(clamp(saved.settings?.echoField?.earlyPathLimit, 32, 4096, DEFAULT_ECHO_FIELD_SETTINGS.earlyPathLimit)),
          lateWalks: Math.round(clamp(saved.settings?.echoField?.lateWalks, 256, 32768, DEFAULT_ECHO_FIELD_SETTINGS.lateWalks)),
          maxBounces: Math.round(clamp(saved.settings?.echoField?.maxBounces, 2, 64, DEFAULT_ECHO_FIELD_SETTINGS.maxBounces)),
          cutoffDb: clamp(saved.settings?.echoField?.cutoffDb, -120, -30, DEFAULT_ECHO_FIELD_SETTINGS.cutoffDb),
          tailPersistence: clamp(saved.settings?.echoField?.tailPersistence, .1, 1, DEFAULT_ECHO_FIELD_SETTINGS.tailPersistence),
          lateMode: saved.settings?.echoField?.lateMode === 'fdn' ? 'fdn' : 'convolution',
          fdnTailSeconds: clamp(saved.settings?.echoField?.fdnTailSeconds, 1, 30, DEFAULT_ECHO_FIELD_SETTINGS.fdnTailSeconds),
          fdnDensity: clamp(saved.settings?.echoField?.fdnDensity, .1, 1, DEFAULT_ECHO_FIELD_SETTINGS.fdnDensity),
          fdnDamping: clamp(saved.settings?.echoField?.fdnDamping, .1, 1, DEFAULT_ECHO_FIELD_SETTINGS.fdnDamping),
          geometryInfluence: clamp(saved.settings?.echoField?.geometryInfluence, 0, 1, DEFAULT_ECHO_FIELD_SETTINGS.geometryInfluence)
        }
      }
    };
  } catch {
    return null;
  }
}

const state = storedWorkspace() ?? structuredClone(initial);
state.pointsLinked ??= false;
state.globalReflectionLevelDb ??= -6;
state.globalMaterial ??= 'generic';
state.settings ??= { heading: 0, reflectionsSolo: false, spatialAudio: true, echoAreaRadiusMetres: 100, echoField: { ...DEFAULT_ECHO_FIELD_SETTINGS } };
state.settings.echoAreaRadiusMetres ??= 100;
state.settings.echoField ??= { ...DEFAULT_ECHO_FIELD_SETTINGS };
state.buildingsVisible = false;
state.reflectors.forEach(reflector => {
  reflector.levelDb ??= state.globalReflectionLevelDb;
  reflector.material ??= 'inherit';
});
let activeTool = null;
let audioContext;
let importedAudioBuffer = null;
let lastSearchAt = 0;
let hoveredBuildingEdge = null;
let automaticReflectors = [];
let echoAreaEnabled = false;
let echoAreaHandle = null;
let echoAreaUpdateTimer = null;
let lateReverbCache = null;
let lateReverbWorker = null;
let rejectLateReverbWorker = null;
let fdnWorkletContext = null;

const protocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);
const initialMapView = storedMapView();

const map = new maplibregl.Map({
  container: 'map',
  center: [initialMapView.longitude, initialMapView.latitude],
  zoom: initialMapView.zoom,
  style: {
    version: 8,
    sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' } },
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
map.addControl(new maplibregl.NavigationControl(), 'bottom-left');
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

function saveWorkspace() {
  try {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({
      source: state.source,
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

$('#global-level').value = state.globalReflectionLevelDb;
$('#global-level-value').textContent = `${state.globalReflectionLevelDb} dB`;
$('#global-material').value = state.globalMaterial;
$('#listener-heading').value = state.settings.heading;
$('#heading-value').textContent = `${state.settings.heading}°`;
$('#heading-arrow').style.transform = `rotate(${state.settings.heading}deg)`;
$('#reflections-solo').checked = state.settings.reflectionsSolo;
$('#spatial-audio').checked = state.settings.spatialAudio;

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
  marker.on('dragend', updatePosition);
  markers.set(id, marker);
}

function syncMarkers() {
  markers.forEach(marker => marker.remove());
  markers.clear();
  if (state.pointsLinked) {
    createMarker('combined', 'combined', state.source, point => {
      state.source = point;
      state.listener = { ...point };
      render();
    });
  } else {
    createMarker('source', 'source', state.source, point => { state.source = point; render(); });
    createMarker('listener', 'listener', state.listener, point => { state.listener = point; render(); });
  }
  state.reflectors.forEach((reflector, index) => createMarker(reflector.id, 'reflector', reflector, point => {
    Object.assign(reflector, point);
    delete reflector.buildingEdge;
    delete reflector.buildingId;
    delete reflector.facadeMaterial;
    render();
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
  if (!echoAreaEnabled) return { type: 'FeatureCollection', features: [] };
  const latitudeRadians = state.listener.latitude * Math.PI / 180;
  const coordinates = Array.from({ length: 65 }, (_, index) => {
    const angle = index / 64 * Math.PI * 2;
    const northMetres = Math.cos(angle) * state.settings.echoAreaRadiusMetres;
    const eastMetres = Math.sin(angle) * state.settings.echoAreaRadiusMetres;
    return [
      state.listener.longitude + eastMetres / (111320 * Math.cos(latitudeRadians)),
      state.listener.latitude + northMetres / 110540
    ];
  });
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coordinates] } };
}

function echoAreaHandlePoint() {
  return {
    latitude: state.listener.latitude,
    longitude: state.listener.longitude + state.settings.echoAreaRadiusMetres / (111320 * Math.cos(state.listener.latitude * Math.PI / 180))
  };
}

function syncEchoAreaGeometry() {
  map.getSource('echo-area')?.setData(circleGeoJson());
  if (echoAreaEnabled && echoAreaHandle) {
    const point = echoAreaHandlePoint();
    echoAreaHandle.setLngLat([point.longitude, point.latitude]);
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

function materialOptions(selected, reflector) {
  const dataMaterial = normalizeFacadeMaterial(reflector.facadeMaterial);
  return Object.entries(MATERIAL_LABELS).map(([value, label]) =>
    `<option value="${value}"${value === selected ? ' selected' : ''}>${label}${value === dataMaterial ? ' · data' : value === 'inherit' && reflector.buildingEdge && !dataMaterial ? ' · no data' : ''}</option>`
  ).join('');
}

function formatDistance(metres) {
  return metres >= 1000 ? `${(metres / 1000).toFixed(2)} km` : `${metres.toFixed(1)} m`;
}

function render() {
  $('#link-points').setAttribute('aria-pressed', String(state.pointsLinked));
  $('.link-label').textContent = state.pointsLinked ? 'Unlink' : 'Link';
  const list = $('#reflection-list');
  list.replaceChildren();
  $('#empty-reflections').hidden = audibleReflectors().length > 0;
  state.reflectors.forEach((reflector, index) => {
    const metrics = reflectionMetrics(state.source, state.listener, reflector);
    const reflectionLevelDb = reflector.levelDb ?? state.globalReflectionLevelDb;
    const card = document.createElement('article');
    card.className = 'reflection';
    card.innerHTML = `<header><h3><span class="tool-symbol symbol-reflector" aria-hidden="true"></span>Reflector ${index + 1}</h3><select class="reflection-material" aria-label="Reflector ${index + 1} material">${materialOptions(reflector.material ?? 'inherit', reflector)}</select><button type="button" aria-label="Remove reflector ${index + 1}">×</button></header>
      <div class="metrics">
        <div class="metric"><span>Listener → reflector</span><strong>${formatDistance(metrics.listenerLegMetres)}</strong></div>
        <div class="metric"><span>Reflection delay</span><strong>${metrics.propagationSeconds.toFixed(3)} s</strong></div>
      </div>
      <label class="level-control">
        <span>Reflection level <output>${reflectionLevelDb} dB</output></span>
        <input type="range" min="-18" max="-1" step="1" value="${reflectionLevelDb}" aria-label="Reflector ${index + 1} reflection level">
      </label>`;
    card.querySelector('button').addEventListener('click', () => {
      state.reflectors = state.reflectors.filter(item => item.id !== reflector.id);
      syncMarkers(); render();
    });
    const levelInput = card.querySelector('input');
    levelInput.addEventListener('input', () => {
      reflector.levelDb = Number(levelInput.value);
      levelInput.previousElementSibling.querySelector('output').textContent = `${reflector.levelDb} dB`;
      saveWorkspace();
    });
    const materialSelect = card.querySelector('.reflection-material');
    materialSelect.title = reflector.facadeMaterial ? `Material · building data: ${reflector.facadeMaterial}` : 'Material';
    materialSelect.addEventListener('change', event => {
      reflector.material = event.currentTarget.value;
      saveWorkspace();
    });
    list.append(card);
  });
  syncRoutes();
  saveWorkspace();
  scheduleEchoAreaUpdate();
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
  map.addSource('echo-area', { type: 'geojson', data: circleGeoJson() });
  map.addLayer({ id: 'echo-area-fill', type: 'fill', source: 'echo-area', paint: { 'fill-color': ACCENT_COLOR, 'fill-opacity': .045 } });
  map.addLayer({ id: 'echo-area-line', type: 'line', source: 'echo-area', paint: { 'line-color': ACCENT_COLOR, 'line-width': 2, 'line-opacity': .9 } });
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

function rebuildEchoArea() {
  if (!echoAreaEnabled || !map.getSource('overture-buildings')) return;
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
  const obstacles = walls.map(({ edge, key }) => ({ edge, key }));
  const candidates = walls.flatMap(wall => {
    const reflection = wallReflectionCandidate({
      ...wall,
      source: state.source,
      listener: state.listener,
      obstacles,
      radiusMetres: state.settings.echoAreaRadiusMetres,
      distanceMetres
    });
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
  const button = $('#echo-area-button');
  button.textContent = `Echo area · ${automaticReflectors.length}${candidates.length > maximumSurfaces ? '+' : ''}`;
  button.title = `${state.settings.echoAreaRadiusMetres.toFixed(0)} m radius · ${automaticReflectors.length} active surfaces`;
  syncEchoAreaGeometry();
  syncRoutes();
  $('#empty-reflections').hidden = audibleReflectors().length > 0;
}

function scheduleEchoAreaUpdate() {
  if (!echoAreaEnabled) return;
  clearTimeout(echoAreaUpdateTimer);
  echoAreaUpdateTimer = setTimeout(rebuildEchoArea, 80);
}

map.on('mousemove', event => {
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
  if (!activeTool) return;
  const point = pointFromLngLat(event.lngLat);
  if (activeTool === 'source') {
    state.source = point;
    if (state.pointsLinked) state.listener = { ...point };
  }
  if (activeTool === 'listener') {
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
  earlyPathLimit: '#setting-early-paths',
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
  earlyPathLimit: ['#setting-early-paths-value', value => Number(value).toLocaleString('en-US')],
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

$('#setting-late-mode').addEventListener('change', syncLateModeSettings);

function syncEchoSettingOutput(setting) {
  const [outputSelector, format] = echoSettingOutputs[setting];
  $(outputSelector).textContent = format($(echoSettingInputs[setting]).value);
}

Object.entries(echoSettingInputs).forEach(([setting, selector]) => {
  $(selector).addEventListener('input', () => syncEchoSettingOutput(setting));
});

$('#echo-settings-button').addEventListener('click', () => {
  $('#setting-late-mode').value = state.settings.echoField.lateMode;
  Object.entries(echoSettingInputs).forEach(([setting, selector]) => {
    $(selector).value = state.settings.echoField[setting];
    syncEchoSettingOutput(setting);
  });
  syncLateModeSettings();
  const dialog = $('#echo-settings-dialog');
  dialog.returnValue = 'cancel';
  dialog.showModal();
  dialog.focus({ preventScroll: true });
});

$('#echo-settings-dialog').addEventListener('close', event => {
  if (event.currentTarget.returnValue !== 'save') return;
  state.settings.echoField = {
    durationSeconds: clamp(Number($('#setting-duration').value), 1, 30, DEFAULT_ECHO_FIELD_SETTINGS.durationSeconds),
    maxSurfaces: Math.round(clamp(Number($('#setting-surfaces').value), 8, 256, DEFAULT_ECHO_FIELD_SETTINGS.maxSurfaces)),
    earlyPathLimit: Math.round(clamp(Number($('#setting-early-paths').value), 32, 4096, DEFAULT_ECHO_FIELD_SETTINGS.earlyPathLimit)),
    lateWalks: Math.round(clamp(Number($('#setting-late-walks').value), 256, 32768, DEFAULT_ECHO_FIELD_SETTINGS.lateWalks)),
    maxBounces: Math.round(clamp(Number($('#setting-bounces').value), 2, 64, DEFAULT_ECHO_FIELD_SETTINGS.maxBounces)),
    cutoffDb: clamp(Number($('#setting-cutoff').value), -120, -30, DEFAULT_ECHO_FIELD_SETTINGS.cutoffDb),
    tailPersistence: clamp(Number($('#setting-persistence').value), .1, 1, DEFAULT_ECHO_FIELD_SETTINGS.tailPersistence),
    lateMode: $('#setting-late-mode').value === 'fdn' ? 'fdn' : 'convolution',
    fdnTailSeconds: clamp(Number($('#setting-fdn-tail').value), 1, 30, DEFAULT_ECHO_FIELD_SETTINGS.fdnTailSeconds),
    fdnDensity: clamp(Number($('#setting-fdn-density').value), .1, 1, DEFAULT_ECHO_FIELD_SETTINGS.fdnDensity),
    fdnDamping: clamp(Number($('#setting-fdn-damping').value), .1, 1, DEFAULT_ECHO_FIELD_SETTINGS.fdnDamping),
    geometryInfluence: clamp(Number($('#setting-geometry-influence').value), 0, 1, DEFAULT_ECHO_FIELD_SETTINGS.geometryInfluence)
  };
  lateReverbCache = null;
  saveWorkspace();
  if (echoAreaEnabled) rebuildEchoArea();
});

$('#clear-reflectors').addEventListener('click', async () => {
  const reflectionCount = audibleReflectors().length;
  if (!reflectionCount) return;
  const confirmed = await requestConfirmation({
    title: 'Clear reflection field?',
    message: `Remove all ${reflectionCount} reflectors and disable Echo area? This cannot be undone.`,
    confirmLabel: 'Clear reflectors'
  });
  if (!confirmed) return;
  if (echoAreaEnabled) setEchoAreaEnabled(false);
  state.reflectors = [];
  syncMarkers();
  render();
});

$('#global-level').addEventListener('input', event => {
  const nextLevelDb = Number(event.currentTarget.value);
  const changeDb = nextLevelDb - state.globalReflectionLevelDb;
  state.globalReflectionLevelDb = nextLevelDb;
  state.reflectors.forEach(reflector => {
    reflector.levelDb = Math.max(-18, Math.min(-1, (reflector.levelDb ?? nextLevelDb) + changeDb));
  });
  $('#global-level-value').textContent = `${nextLevelDb} dB`;
  render();
});

$('#global-material').addEventListener('change', event => {
  state.globalMaterial = event.currentTarget.value;
  saveWorkspace();
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
  button.disabled = loading;
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
    $('#echo-area-button').disabled = !loaded;
    if (loaded) $('#echo-area-button').title = 'Create an automatic echo field around the Listener';
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
  if (!map.loaded()) return;
  const firstLoad = !map.getSource('overture-buildings');
  if (firstLoad) monitorInitialBuildingLoad();
  addBuildingLayers();
  state.buildingsVisible = !state.buildingsVisible;
  setBuildingLayerVisibility(state.buildingsVisible);
  if (!state.buildingsVisible) clearBuildingHover();
  const button = $('#buildings-button');
  button.setAttribute('aria-pressed', String(state.buildingsVisible));
  button.title = state.buildingsVisible ? 'Hide building data' : 'Load building data';
  $('#echo-area-button').disabled = !state.buildingsVisible || firstLoad;
  if (!state.buildingsVisible && echoAreaEnabled) setEchoAreaEnabled(false);
  if (state.buildingsVisible && map.getZoom() < 14) map.easeTo({ zoom: 14 });
});

function setEchoAreaEnabled(enabled) {
  echoAreaEnabled = enabled;
  const button = $('#echo-area-button');
  button.setAttribute('aria-pressed', String(enabled));
  if (enabled) {
    const element = document.createElement('div');
    element.className = 'echo-area-handle';
    element.setAttribute('aria-label', 'Echo area radius');
    const point = echoAreaHandlePoint();
    echoAreaHandle = new maplibregl.Marker({ element, draggable: true })
      .setLngLat([point.longitude, point.latitude]).addTo(map);
    const updateRadius = () => {
      state.settings.echoAreaRadiusMetres = Math.max(10, distanceMetres(state.listener, pointFromLngLat(echoAreaHandle.getLngLat())));
      saveWorkspace();
      syncEchoAreaGeometry();
      scheduleEchoAreaUpdate();
    };
    echoAreaHandle.on('drag', updateRadius);
    echoAreaHandle.on('dragend', updateRadius);
    syncEchoAreaGeometry();
    rebuildEchoArea();
  } else {
    clearTimeout(echoAreaUpdateTimer);
    echoAreaHandle?.remove();
    echoAreaHandle = null;
    automaticReflectors = [];
    button.textContent = 'Echo area';
    button.title = 'Create an automatic echo field around the Listener';
    syncEchoAreaGeometry();
    render();
  }
}

$('#echo-area-button').addEventListener('click', () => setEchoAreaEnabled(!echoAreaEnabled));

map.on('moveend', scheduleEchoAreaUpdate);

$('#link-points').addEventListener('click', () => {
  state.pointsLinked = !state.pointsLinked;
  if (state.pointsLinked) state.listener = { ...state.source };
  syncMarkers();
  render();
});

async function searchLocation(query) {
  const parsed = parseCoordinates(query);
  if (parsed) return { ...parsed, label: coordinateText(parsed) };
  const cacheKey = `echotect-search:${query.toLocaleLowerCase()}`;
  const cached = sessionStorage.getItem(cacheKey);
  if (cached) return JSON.parse(cached);
  const wait = Math.max(0, 1000 - (Date.now() - lastSearchAt));
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  lastSearchAt = Date.now();
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.search = new URLSearchParams({ q: query, format: 'jsonv2', limit: '1', 'accept-language': 'en' });
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('The place search service did not respond.');
  const [result] = await response.json();
  if (!result) return null;
  const location = { latitude: Number(result.lat), longitude: Number(result.lon), label: result.display_name };
  sessionStorage.setItem(cacheKey, JSON.stringify(location));
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
  saveWorkspace();
});

$('#reflections-solo').addEventListener('change', event => {
  state.settings.reflectionsSolo = event.currentTarget.checked;
  saveWorkspace();
});

$('#spatial-audio').addEventListener('change', event => {
  state.settings.spatialAudio = event.currentTarget.checked;
  saveWorkspace();
});

function getAudioContext() {
  audioContext ??= new AudioContext();
  return audioContext;
}

function createHandclap(context) {
  const duration = .23;
  const buffer = context.createBuffer(1, context.sampleRate * duration, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < data.length; index += 1) {
    const time = index / context.sampleRate;
    const bursts = [0, .026, .052].reduce((sum, start) => sum + (time >= start ? Math.exp(-(time - start) * 42) : 0), 0);
    data[index] = (Math.random() * 2 - 1) * bursts * .34;
  }
  return buffer;
}

function playBufferAt(context, buffer, time, gainValue, position) {
  const source = context.createBufferSource();
  const filter = context.createBiquadFilter();
  const gain = context.createGain();
  source.buffer = buffer;
  filter.type = 'bandpass'; filter.frequency.value = 1500; filter.Q.value = .7;
  gain.gain.value = gainValue;
  source.connect(filter).connect(gain);
  if (position && $('#spatial-audio').checked) {
    const panner = context.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1;
    panner.maxDistance = 2;
    panner.rolloffFactor = 0;
    panner.positionX.value = position.x;
    panner.positionY.value = position.y;
    panner.positionZ.value = position.z;
    gain.connect(panner).connect(context.destination);
  } else {
    gain.connect(context.destination);
  }
  source.start(time);
}

function createLateReverbInWorker(context, options) {
  rejectLateReverbWorker?.(new DOMException('Audio preparation cancelled.', 'AbortError'));
  lateReverbWorker?.terminate();
  const worker = new Worker(new URL('./late-reverb-worker.js', import.meta.url), { type: 'module' });
  lateReverbWorker = worker;
  return new Promise((resolve, reject) => {
    rejectLateReverbWorker = reject;
    worker.addEventListener('message', event => {
      worker.terminate();
      if (lateReverbWorker === worker) lateReverbWorker = null;
      if (lateReverbWorker === null) rejectLateReverbWorker = null;
      if (event.data.error) return reject(new Error(event.data.error));
      const channels = event.data.channels.map(channel => new Float32Array(channel));
      const reverbBuffer = context.createBuffer(2, channels[0].length, context.sampleRate);
      channels.forEach((channel, index) => reverbBuffer.copyToChannel(channel, index));
      resolve(reverbBuffer);
    }, { once: true });
    worker.addEventListener('error', error => {
      worker.terminate();
      if (lateReverbWorker === worker) lateReverbWorker = null;
      if (lateReverbWorker === null) rejectLateReverbWorker = null;
      reject(error);
    }, { once: true });
    worker.postMessage({ ...options, sampleRate: context.sampleRate });
  });
}

async function prepareLateReverb(context, reflectors, heading) {
  if (reflectors.length < 2) return null;
  const cacheKey = JSON.stringify({ source: state.source, listener: state.listener, heading, reflectors, settings: state.settings.echoField });
  if (!lateReverbCache || lateReverbCache.context !== context || lateReverbCache.key !== cacheKey) {
    lateReverbCache = {
      context,
      key: cacheKey,
      buffer: await createLateReverbInWorker(context, {
        source: state.source,
        listener: state.listener,
        reflectors,
        heading,
        durationSeconds: state.settings.echoField.durationSeconds,
        maxBounces: state.settings.echoField.maxBounces,
        walkCount: state.settings.echoField.lateWalks,
        cutoffDb: state.settings.echoField.cutoffDb,
        decayScale: 1.1 - state.settings.echoField.tailPersistence
      })
    };
  }
  return lateReverbCache.buffer;
}

function playLateReverb(context, buffer, time, reverbBuffer) {
  if (!reverbBuffer) return;
  const source = context.createBufferSource();
  const convolver = context.createConvolver();
  const gain = context.createGain();
  source.buffer = buffer;
  convolver.normalize = false;
  convolver.buffer = reverbBuffer;
  gain.gain.value = .7;
  source.connect(convolver).connect(gain).connect(context.destination);
  source.start(time);
}

async function prepareFeedbackDelayNetwork(context, reflectors) {
  if (reflectors.length < 2) return false;
  if (fdnWorkletContext !== context) {
    await context.audioWorklet.addModule(new URL('./fdn-worklet.js', import.meta.url));
    fdnWorkletContext = context;
  }
  return true;
}

function playFeedbackDelayNetwork(context, buffer, time, reflectors) {
  if (reflectors.length < 2) return;
  const source = context.createBufferSource();
  const gain = context.createGain();
  const settings = state.settings.echoField;
  const processorOptions = createFdnConfiguration({
    sampleRate: context.sampleRate,
    source: state.source,
    listener: state.listener,
    reflectors,
    heading: Number($('#listener-heading').value),
    distanceMetres,
    tailSeconds: settings.fdnTailSeconds,
    density: settings.fdnDensity,
    damping: settings.fdnDamping,
    geometryInfluence: settings.geometryInfluence
  });
  const fdn = new AudioWorkletNode(context, 'echotect-fdn', { outputChannelCount: [2], processorOptions });
  source.buffer = buffer;
  gain.gain.value = .65;
  source.connect(fdn).connect(gain).connect(context.destination);
  source.start(time);
}

$('#play-button').addEventListener('click', async () => {
  const button = $('#play-button');
  const busyStartedAt = performance.now();
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  await new Promise(resolve => requestAnimationFrame(resolve));
  try {
    const context = getAudioContext();
    await context.resume();
    const buffer = importedAudioBuffer ?? createHandclap(context);
    const direct = directSoundMetrics(state.source, state.listener);
    const reflectorsWithLevels = audibleReflectors().map(reflector => ({
      ...reflector,
      levelDb: (reflector.levelDb ?? state.globalReflectionLevelDb)
        + MATERIAL_ATTENUATION_DB[effectiveMaterial(reflector, state.globalMaterial)]
    }));
    const listenerHeading = Number($('#listener-heading').value);
    const lateMode = state.settings.echoField.lateMode;
    const lateReverbBuffer = lateMode === 'convolution'
      ? await prepareLateReverb(context, reflectorsWithLevels, listenerHeading)
      : null;
    if (lateMode === 'fdn') await prepareFeedbackDelayNetwork(context, reflectorsWithLevels);
    const now = context.currentTime + .03;
    const reflectionsSolo = $('#reflections-solo').checked;
    const sourcePosition = hrtfPosition(state.listener, state.source, listenerHeading);
    if (!reflectionsSolo) {
      playBufferAt(context, buffer, now, .8, sourcePosition);
      if (hasDistinctDirectArrival(state.source, state.listener)) {
        const directAttenuation = Math.max(.18, Math.min(.72, 140 / Math.max(140, direct.pathMetres)));
        playBufferAt(context, buffer, now + direct.propagationSeconds, directAttenuation, sourcePosition);
      }
    }
    buildReflectionPaths(reflectorsWithLevels, {
      maxBounces: Math.min(2, state.settings.echoField.maxBounces),
      maxPaths: state.settings.echoField.earlyPathLimit,
      thresholdDb: state.settings.echoField.cutoffDb
    }).forEach(reflectorPath => {
      const { propagationSeconds, pathMetres } = reflectionPathMetrics(state.source, state.listener, reflectorPath);
      const attenuation = Math.max(.12, Math.min(.65, 140 / Math.max(140, pathMetres)));
      const gain = reflectionPathGain(attenuation, reflectorPath);
      if (gainToDecibels(gain) >= state.settings.echoField.cutoffDb) {
        const arrivalPosition = hrtfPosition(state.listener, reflectorPath.at(-1), listenerHeading);
        playBufferAt(context, buffer, now + propagationSeconds, gain, arrivalPosition);
      }
    });
    if (lateMode === 'fdn') {
      playFeedbackDelayNetwork(context, buffer, now, reflectorsWithLevels);
    } else {
      playLateReverb(context, buffer, now, lateReverbBuffer);
    }
  } catch (error) {
    if (error?.name !== 'AbortError') console.error(error);
  } finally {
    const remainingBusyTime = Math.max(0, 2000 - (performance.now() - busyStartedAt));
    if (remainingBusyTime) await new Promise(resolve => setTimeout(resolve, remainingBusyTime));
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
});

$('#audio-file').addEventListener('change', async event => {
  const [file] = event.target.files;
  if (!file) return;
  try {
    const context = getAudioContext();
    importedAudioBuffer = await context.decodeAudioData(await file.arrayBuffer());
    $('#sound-name').textContent = `Sound: ${file.name}`;
  } catch {
    importedAudioBuffer = null;
    $('#sound-name').textContent = 'Sound: file could not be opened';
  }
});

$('#default-sound').addEventListener('click', () => {
  importedAudioBuffer = null;
  $('#audio-file').value = '';
  $('#sound-name').textContent = 'Sound: Echotect handclap';
});

$('#reset-audio').addEventListener('click', async event => {
  const button = event.currentTarget;
  const context = audioContext;
  audioContext = null;
  lateReverbCache = null;
  rejectLateReverbWorker?.(new DOMException('Audio preparation cancelled.', 'AbortError'));
  rejectLateReverbWorker = null;
  lateReverbWorker?.terminate();
  lateReverbWorker = null;
  fdnWorkletContext = null;
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
