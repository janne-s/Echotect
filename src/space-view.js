/** Profiles drawn across the terrain, and samples along each one. */
const PROFILE_COUNT = 44;
const PROFILE_SAMPLES = 110;
/** Relief is exaggerated for display until it spans this share of the terrain's width. */
const TARGET_RELIEF_SHARE = .3;
const SECTION_RELIEF_SHARE = .45;
const MAXIMUM_EXAGGERATION = 20;
const VIEW_MARGIN = .06;
const SCALE_BAR_STEPS = [1, 2, 5];

export const DEFAULT_SPACE_VIEW = Object.freeze({ yaw: -.6, pitch: .62, zoom: 1, panX: 0, panY: 0 });
const MINIMUM_ZOOM = .4;
const MAXIMUM_ZOOM = 4;

function exaggeration(reliefMetres, extentMetres, share) {
  if (!(reliefMetres > 0)) return 1;
  return Math.min(MAXIMUM_EXAGGERATION, Math.max(1, share * extentMetres / reliefMetres));
}

const formatExaggeration = value => value > 1.05 ? `vertical ×${value < 10 ? value.toFixed(1) : Math.round(value)}` : '';

export function formatLength(metres) {
  if (metres >= 1000) return `${(metres / 1000).toFixed(metres >= 10000 ? 0 : 1)} km`;
  return `${Math.round(metres)} m`;
}

function niceLength(metres) {
  const magnitude = 10 ** Math.floor(Math.log10(metres));
  return SCALE_BAR_STEPS.map(step => step * magnitude).filter(value => value <= metres).at(-1) ?? magnitude;
}

function prepareCanvas(canvas) {
  const ratio = globalThis.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  return { context, width, height };
}

function label(context, palette, text, x, y, align = 'left') {
  if (!text) return;
  context.font = '10px ui-monospace, monospace';
  context.fillStyle = palette.muted;
  context.textAlign = align;
  context.fillText(text, x, y);
}

function drawPoint(context, palette, point, kind) {
  context.beginPath();
  context.arc(point.x, point.y, kind === 'reflector' ? 1.8 : 4.5, 0, Math.PI * 2);
  if (kind === 'source') { context.fillStyle = palette.accent; context.fill(); }
  else if (kind === 'listener') { context.fillStyle = '#111'; context.fill(); context.lineWidth = 2; context.strokeStyle = palette.ink; context.stroke(); }
  else { context.fillStyle = palette.accent; context.fill(); }
}

function drawDirect(context, palette, from, to, occluded) {
  context.save();
  context.setLineDash(occluded ? [2, 3] : [4, 3]);
  context.globalAlpha = occluded ? .45 : .9;
  context.strokeStyle = palette.accent;
  context.lineWidth = 1.2;
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.stroke();
  context.restore();
}

/**
 * Frames the terrain block from its floor to its highest point. The horizontal extent is the
 * footprint's circumscribed circle, so the framing does not change while the block turns.
 */
function spaceFit(frame, view, width, height) {
  const { widthMetres, heightMetres, minimumElevation, maximumElevation, mode, floor } = frame;
  const extent = Math.max(widthMetres, heightMetres);
  const vertical = exaggeration(maximumElevation - minimumElevation, extent, TARGET_RELIEF_SHARE);
  const base = mode === 'interior' ? floor : minimumElevation;
  const radius = Math.hypot(widthMetres, heightMetres) / 2 / extent;
  const lift = elevation => (elevation - minimumElevation) / extent * vertical * Math.cos(view.pitch);
  const reach = radius * Math.sin(view.pitch);
  const top = lift(maximumElevation) + reach;
  const bottom = lift(base) - reach;
  const pixels = Math.min(width / (2 * radius), height / Math.max(top - bottom, 1e-6)) * (1 - VIEW_MARGIN * 2);
  return { extent, vertical, base, middleUp: (top + bottom) / 2, pixels };
}

/** Zooms toward the canvas point (x, y), keeping the terrain under it in place. */
export function zoomSpaceView(frame, view, width, height, x, y, factor) {
  const zoom = Math.min(MAXIMUM_ZOOM, Math.max(MINIMUM_ZOOM, view.zoom * factor));
  const { pixels } = spaceFit(frame, view, width, height);
  const shift = 1 / view.zoom - 1 / zoom;
  return {
    ...view,
    zoom,
    panX: view.panX + (x - width / 2) / pixels * shift,
    panY: view.panY - (y - height / 2) / pixels * shift
  };
}

/**
 * The terrain as stacked profiles seen from an orbit, the way GeoFlute shows a wavetable bank.
 * Canyon draws the surface with air above it; Chamber draws the ceiling over the floor and tints
 * the air between them, so the cavity narrowing upward is visible.
 */
export function drawSpace(canvas, { frame, placement, reflectors = [] }, view, palette) {
  const { context, width, height } = prepareCanvas(canvas);
  const { widthMetres, heightMetres, minimumElevation, mode, floor, scale } = frame;
  const chamber = mode === 'interior';
  const { extent, vertical, base, middleUp, pixels } = spaceFit(frame, view, width, height);
  const cosine = Math.cos(view.yaw);
  const sine = Math.sin(view.yaw);
  const pitchCosine = Math.cos(view.pitch);
  const pitchSine = Math.sin(view.pitch);
  const zoomed = pixels * view.zoom;
  const project = (x, y, z) => {
    const nx = x / extent; const ny = y / extent; const nz = (z - minimumElevation) / extent * vertical;
    const across = nx * cosine - ny * sine;
    const depth = nx * sine + ny * cosine;
    const up = nz * pitchCosine + depth * pitchSine;
    return { x: width / 2 + (across - view.panX) * zoomed, y: height / 2 - (up - middleUp - view.panY) * zoomed, depth };
  };

  const alongX = Math.abs(cosine) >= Math.abs(sine);
  const profiles = [];
  for (let index = 0; index < PROFILE_COUNT; index += 1) {
    const across = -.5 + (index + .5) / PROFILE_COUNT;
    const points = [];
    for (let sample = 0; sample <= PROFILE_SAMPLES; sample += 1) {
      const along = -.5 + sample / PROFILE_SAMPLES;
      const x = (alongX ? along : across) * widthMetres * .999;
      const y = (alongX ? across : along) * heightMetres * .999;
      const surface = frame.elevation(x, y);
      points.push({ x, y, surface, z: chamber ? Math.max(surface, floor) : surface });
    }
    const middle = points[PROFILE_SAMPLES >> 1];
    profiles.push({ points, depth: project(middle.x, middle.y, base).depth });
  }
  profiles.sort((a, b) => b.depth - a.depth);

  context.lineJoin = 'round';
  for (const { points } of profiles) {
    const top = points.map(point => project(point.x, point.y, point.z));
    const bottom = points.map(point => project(point.x, point.y, base)).reverse();
    context.beginPath();
    [...top, ...bottom].forEach((point, index) => (index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y)));
    context.closePath();
    context.fillStyle = palette.panel;
    context.fill();
    if (chamber) {
      context.fillStyle = palette.air;
      context.fill();
    }
    context.beginPath();
    top.forEach((point, index) => (index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y)));
    context.strokeStyle = palette.line;
    context.lineWidth = 1;
    context.stroke();
  }

  const toScreen = world => project(world.x / scale, world.y / scale, world.z / scale + frame.referenceElevation);
  if (placement?.valid) {
    const source = toScreen(placement.source.positionMetres);
    const listener = toScreen(placement.listener.positionMetres);
    reflectors.forEach(reflector => drawPoint(context, palette, toScreen(reflector.positionMetres), 'reflector'));
    drawDirect(context, palette, source, listener, placement.directOccluded);
    drawPoint(context, palette, source, 'source');
    drawPoint(context, palette, listener, 'listener');
  }
  label(context, palette, `${formatLength(widthMetres * scale)} × ${formatLength(heightMetres * scale)}`, 8, height - 8);
  label(context, palette, formatExaggeration(vertical), width - 8, height - 8, 'right');
  return toScreen;
}

/** Keeps the drawn space so reflection pulses can be animated over it without redrawing the terrain. */
export function captureSpaceScene(canvas, toScreen) {
  const snapshot = document.createElement('canvas');
  snapshot.width = canvas.width;
  snapshot.height = canvas.height;
  snapshot.getContext('2d').drawImage(canvas, 0, 0);
  return { canvas, snapshot, toScreen };
}

/** Reflection pulses light the reflectors they arrive from, as the map does. */
export function paintSpacePulses({ canvas, snapshot, toScreen }, pulses) {
  const context = canvas.getContext('2d');
  const ratio = canvas.width / Math.max(1, canvas.clientWidth);
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(snapshot, 0, 0);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  for (const { positionMetres, alpha } of pulses) {
    const point = toScreen(positionMetres);
    context.beginPath();
    context.arc(point.x, point.y, 2.5 + 3 * alpha, 0, Math.PI * 2);
    context.fillStyle = `rgba(255, 255, 255, ${alpha})`;
    context.fill();
  }
}

/**
 * The vertical section through Source and Listener. Rock is filled; air is left open above the
 * ground in Canyon and tinted between floor and ceiling in Chamber. The scale bar is in acoustic
 * metres, so it shows what the scale setting does to the space.
 */
export function drawSection(canvas, { frame, placement, section }, palette) {
  const { context, width, height } = prepareCanvas(canvas);
  if (!section) return;
  const chamber = frame.mode === 'interior';
  const surfaces = section.points.map(point => point.surfaceMetres);
  const lowest = Math.min(...surfaces, chamber ? section.floorMetres : Infinity);
  const highest = Math.max(...surfaces, placement?.valid ? Math.max(placement.source.positionMetres.z, placement.listener.positionMetres.z) : -Infinity);
  const vertical = exaggeration(highest - lowest, section.lengthMetres, SECTION_RELIEF_SHARE);
  const margin = 10;
  const horizontalScale = (width - margin * 2) / section.lengthMetres;
  const verticalScale = Math.min(horizontalScale * vertical, (height - margin * 3) / Math.max(1, highest - lowest));
  const toX = distance => margin + distance * horizontalScale;
  const toY = z => height - margin * 2 - (z - lowest) * verticalScale;

  context.fillStyle = palette.rock;
  context.fillRect(0, 0, width, height);
  context.beginPath();
  if (chamber) {
    section.points.forEach((point, index) => {
      const ceiling = Math.max(point.surfaceMetres, section.floorMetres);
      const x = toX(point.distanceMetres);
      if (index) context.lineTo(x, toY(ceiling)); else context.moveTo(x, toY(ceiling));
    });
    [...section.points].reverse().forEach(point => context.lineTo(toX(point.distanceMetres), toY(section.floorMetres)));
  } else {
    section.points.forEach((point, index) => {
      const x = toX(point.distanceMetres);
      if (index) context.lineTo(x, toY(point.surfaceMetres)); else context.moveTo(x, toY(point.surfaceMetres));
    });
    context.lineTo(width, 0);
    context.lineTo(0, 0);
  }
  context.closePath();
  context.fillStyle = palette.panel;
  context.fill();
  if (chamber) {
    context.fillStyle = palette.air;
    context.fill();
  }
  context.beginPath();
  section.points.forEach((point, index) => {
    const z = chamber ? Math.max(point.surfaceMetres, section.floorMetres) : point.surfaceMetres;
    if (index) context.lineTo(toX(point.distanceMetres), toY(z)); else context.moveTo(toX(point.distanceMetres), toY(z));
  });
  context.strokeStyle = palette.line;
  context.lineWidth = 1.2;
  context.stroke();

  if (placement?.valid) {
    const source = { x: toX(section.sourceDistanceMetres), y: toY(placement.source.positionMetres.z) };
    const listener = { x: toX(section.listenerDistanceMetres), y: toY(placement.listener.positionMetres.z) };
    drawDirect(context, palette, source, listener, placement.directOccluded);
    drawPoint(context, palette, source, 'source');
    drawPoint(context, palette, listener, 'listener');
  }

  const bar = niceLength(section.lengthMetres / 4);
  const barY = height - 6;
  context.strokeStyle = palette.muted;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(margin, barY - 3); context.lineTo(margin, barY); context.lineTo(margin + bar * horizontalScale, barY); context.lineTo(margin + bar * horizontalScale, barY - 3);
  context.stroke();
  label(context, palette, formatLength(bar), margin + bar * horizontalScale + 5, barY);
  label(context, palette, formatExaggeration(vertical), width - 8, barY, 'right');
}
