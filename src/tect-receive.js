import { distanceMetres, EARTH_RADIUS_METRES, toRadians } from './geo.js';
import { HANDOFF_FORMAT, readHandoff } from './handoff.js';

export function destinationPoint(point, bearingDegrees, metres) {
  const angle = metres / EARTH_RADIUS_METRES;
  const bearing = toRadians(bearingDegrees);
  const latitude = toRadians(point.latitude);
  const longitude = toRadians(point.longitude);
  const nextLatitude = Math.asin(Math.sin(latitude) * Math.cos(angle) + Math.cos(latitude) * Math.sin(angle) * Math.cos(bearing));
  const nextLongitude = longitude + Math.atan2(Math.sin(bearing) * Math.sin(angle) * Math.cos(latitude), Math.cos(angle) - Math.sin(latitude) * Math.sin(nextLatitude));
  return { latitude: nextLatitude * 180 / Math.PI, longitude: ((nextLongitude * 180 / Math.PI + 540) % 360) - 180 };
}

export function bearingDegrees(from, to) {
  const a = toRadians(from.latitude);
  const b = toRadians(to.latitude);
  const delta = toRadians(to.longitude - from.longitude);
  return (Math.atan2(Math.sin(delta) * Math.cos(b), Math.cos(a) * Math.sin(b) - Math.sin(a) * Math.cos(b) * Math.cos(delta)) * 180 / Math.PI + 360) % 360;
}

const offsetPoint = (origin, east, north) => (east === 0 && north === 0 ? { ...origin } : destinationPoint(origin, Math.atan2(east, north) * 180 / Math.PI, Math.hypot(east, north)));

export function handoffPlacement(handoff, current) {
  const { place, listener: heard, arrival, placement } = handoff;
  const moveListener = placement === 'listener-and-source' && Boolean(place);
  const moveSource = placement !== 'none';
  const listener = moveListener
    ? offsetPoint({ latitude: place.latitudeDegrees, longitude: place.longitudeDegrees }, heard.positionMetres.east, heard.positionMetres.north)
    : { ...current.listener };
  const listenerHeightMetres = moveListener ? heard.heightAboveGroundMetres : current.heightsMetres?.listener ?? heard.heightAboveGroundMetres;
  const currentSourceHeight = current.heightsMetres?.source ?? listenerHeightMetres;
  if (!moveSource) return { listener, source: { ...current.source }, listenerHeightMetres, sourceHeightMetres: currentSourceHeight, moved: moveListener };
  const currentMetres = distanceMetres(current.listener, current.source);
  const source = arrival
    ? destinationPoint(listener, arrival.azimuthDegrees, (arrival.distanceMetres ?? currentMetres) * Math.cos(toRadians(arrival.elevationDegrees)))
    : currentMetres > 0 ? destinationPoint(listener, bearingDegrees(current.listener, current.source), currentMetres) : { ...listener };
  const sourceHeightMetres = arrival
    ? listenerHeightMetres + (arrival.distanceMetres ?? currentMetres) * Math.sin(toRadians(arrival.elevationDegrees))
    : currentSourceHeight;
  return { listener, source, listenerHeightMetres, sourceHeightMetres: Math.max(0, sourceHeightMetres), moved: moveListener };
}

export const handoffAirMetres = handoff => (handoff.content.includes.includes('air-absorption') ? handoff.arrival?.distanceMetres ?? 0 : 0);

export function packagedHandoffs(files) {
  const byName = new Map(files.map(file => [file.name, file]));
  const decoder = new TextDecoder();
  return files.filter(file => file.name.toLowerCase().endsWith('.json')).flatMap(file => {
    let value;
    try { value = JSON.parse(decoder.decode(file.data)); } catch { return []; }
    if (value?.format !== HANDOFF_FORMAT) return [];
    const handoff = readHandoff(value);
    const wav = handoff.audio.file && byName.get(handoff.audio.file);
    return wav ? [{ handoff, wav: wav.data }] : [];
  });
}
