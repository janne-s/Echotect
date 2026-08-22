import { parseCoordinates, reflectionMetrics } from './geo.js';

const initial = {
  source: { latitude: 60.16955, longitude: 24.9369 },
  listener: { latitude: 60.1707, longitude: 24.9410 },
  reflectors: [{ id: crypto.randomUUID(), latitude: 60.1721, longitude: 24.9384 }]
};
const state = structuredClone(initial);
let activeTool = null;
let audioContext;
let importedAudioBuffer = null;
let lastSearchAt = 0;

const map = new maplibregl.Map({
  container: 'map',
  center: [24.939, 60.1706],
  zoom: 15,
  style: {
    version: 8,
    sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' } },
    layers: [{
      id: 'osm',
      type: 'raster',
      source: 'osm',
      paint: { 'raster-saturation': -1, 'raster-contrast': .08, 'raster-brightness-max': .82 }
    }]
  }
});
map.addControl(new maplibregl.NavigationControl(), 'bottom-left');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }));

const markers = new Map();
const $ = selector => document.querySelector(selector);
const coordinateText = point => `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`;
const pointFromLngLat = lngLat => ({ latitude: lngLat.lat, longitude: lngLat.lng });

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
  createMarker('source', 'source', state.source, point => { state.source = point; render(); });
  createMarker('listener', 'listener', state.listener, point => { state.listener = point; render(); });
  state.reflectors.forEach((reflector, index) => createMarker(reflector.id, 'reflector', reflector, point => {
    Object.assign(reflector, point); render();
  }, String(index + 1)));
}

function routeGeoJson() {
  return {
    type: 'FeatureCollection',
    features: state.reflectors.map(reflector => ({
      type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [
        [state.source.longitude, state.source.latitude],
        [reflector.longitude, reflector.latitude],
        [state.listener.longitude, state.listener.latitude]
      ] }
    }))
  };
}

function syncRoutes() {
  const source = map.getSource('routes');
  if (source) source.setData(routeGeoJson());
}

function formatDistance(metres) {
  return metres >= 1000 ? `${(metres / 1000).toFixed(2)} km` : `${metres.toFixed(1)} m`;
}

function render() {
  $('#source-coordinates').textContent = coordinateText(state.source);
  $('#listener-coordinates').textContent = coordinateText(state.listener);
  const list = $('#reflection-list');
  list.replaceChildren();
  $('#empty-reflections').hidden = state.reflectors.length > 0;
  state.reflectors.forEach((reflector, index) => {
    const metrics = reflectionMetrics(state.source, state.listener, reflector);
    const card = document.createElement('article');
    card.className = 'reflection';
    card.innerHTML = `<header><h3><span class="tool-symbol symbol-reflector" aria-hidden="true"></span>Reflector ${index + 1}</h3><button type="button" aria-label="Remove reflector ${index + 1}">×</button></header>
      <div class="metrics">
        <div class="metric"><span>Listener → reflector</span><strong>${formatDistance(metrics.listenerLegMetres)}</strong></div>
        <div class="metric"><span>Reflection delay</span><strong>${metrics.propagationSeconds.toFixed(3)} s</strong></div>
      </div>
      <p class="route">Full path ${formatDistance(metrics.pathMetres)} · ${coordinateText(reflector)}</p>`;
    card.querySelector('button').addEventListener('click', () => {
      state.reflectors = state.reflectors.filter(item => item.id !== reflector.id);
      syncMarkers(); render();
    });
    list.append(card);
  });
  syncRoutes();
}

map.on('load', () => {
  map.addSource('routes', { type: 'geojson', data: routeGeoJson() });
  map.addLayer({ id: 'routes', type: 'line', source: 'routes', paint: { 'line-color': '#ff69b4', 'line-width': 3, 'line-opacity': .9 } });
  syncMarkers(); render();
});

map.on('click', event => {
  if (!activeTool) return;
  const point = pointFromLngLat(event.lngLat);
  if (activeTool === 'source') state.source = point;
  if (activeTool === 'listener') state.listener = point;
  if (activeTool === 'reflector') state.reflectors.push({ id: crypto.randomUUID(), ...point });
  syncMarkers(); render();
});

document.querySelectorAll('[data-tool]').forEach(button => button.addEventListener('click', () => {
  activeTool = activeTool === button.dataset.tool ? null : button.dataset.tool;
  document.querySelectorAll('[data-tool]').forEach(item => item.classList.toggle('active', item.dataset.tool === activeTool));
  $('#map-hint').textContent = activeTool ? `Select the ${activeTool} location on the map.` : 'Choose a tool, then select a location on the map.';
}));

$('#clear-reflectors').addEventListener('click', () => { state.reflectors = []; syncMarkers(); render(); });

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
  const query = $('#location-input').value.trim();
  if (!query) return;
  $('#status').textContent = 'Searching for the place…';
  try {
    const location = await searchLocation(query);
    if (!location) { $('#status').textContent = 'No matching place was found.'; return; }
    map.flyTo({ center: [location.longitude, location.latitude], zoom: 16 });
    $('#status').textContent = `Map moved to: ${location.label}`;
  } catch (error) { $('#status').textContent = error.message; }
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

function playBufferAt(context, buffer, time, gainValue) {
  const source = context.createBufferSource();
  const filter = context.createBiquadFilter();
  const gain = context.createGain();
  source.buffer = buffer;
  filter.type = 'bandpass'; filter.frequency.value = 1500; filter.Q.value = .7;
  gain.gain.value = gainValue;
  source.connect(filter).connect(gain).connect(context.destination);
  source.start(time);
}

$('#play-button').addEventListener('click', async () => {
  const context = getAudioContext();
  await context.resume();
  const buffer = importedAudioBuffer ?? createHandclap(context);
  const now = context.currentTime + .03;
  playBufferAt(context, buffer, now, .8);
  state.reflectors.forEach(reflector => {
    const { propagationSeconds, pathMetres } = reflectionMetrics(state.source, state.listener, reflector);
    const attenuation = Math.max(.12, Math.min(.65, 140 / Math.max(140, pathMetres)));
    playBufferAt(context, buffer, now + propagationSeconds, attenuation);
  });
  $('#status').textContent = state.reflectors.length ? `Playing ${state.reflectors.length} ${state.reflectors.length === 1 ? 'reflection' : 'reflections'}.` : 'Playing the dry sound. Add a reflector to hear an echo.';
});

$('#audio-file').addEventListener('change', async event => {
  const [file] = event.target.files;
  if (!file) return;
  try {
    const context = getAudioContext();
    importedAudioBuffer = await context.decodeAudioData(await file.arrayBuffer());
    $('#sound-name').textContent = `Sound: ${file.name}`;
    $('#status').textContent = 'Your sound is ready to play.';
  } catch {
    importedAudioBuffer = null;
    $('#status').textContent = 'This audio file could not be opened.';
  }
});

$('#default-sound').addEventListener('click', () => {
  importedAudioBuffer = null;
  $('#audio-file').value = '';
  $('#sound-name').textContent = 'Sound: Echotect handclap';
  $('#status').textContent = 'The default handclap is active.';
});
