import { distanceMetres, EARTH_RADIUS_METRES, toRadians } from './geo.js';
import { HANDOFF_FORMAT, readHandoff } from './handoff.js';

/**
 * Taking up a sound handed over by another tect (`handoff.js`), such as a Boomtect microphone: where
 * the Listener and Source go, and how much of the air the sound already holds. Coordinates are WGS84
 * degrees; bearings are compass degrees from north.
 */

/** The point `metres` from `point` along the great circle leaving it at `bearingDegrees`. */
export function destinationPoint(point, bearingDegrees, metres) {
  const angle = metres / EARTH_RADIUS_METRES;
  const bearing = toRadians(bearingDegrees);
  const latitude = toRadians(point.latitude);
  const longitude = toRadians(point.longitude);
  const nextLatitude = Math.asin(Math.sin(latitude) * Math.cos(angle) + Math.cos(latitude) * Math.sin(angle) * Math.cos(bearing));
  const nextLongitude = longitude + Math.atan2(Math.sin(bearing) * Math.sin(angle) * Math.cos(latitude), Math.cos(angle) - Math.sin(latitude) * Math.sin(nextLatitude));
  return { latitude: nextLatitude * 180 / Math.PI, longitude: ((nextLongitude * 180 / Math.PI + 540) % 360) - 180 };
}

/** The compass bearing from one point toward another. */
export function bearingDegrees(from, to) {
  const a = toRadians(from.latitude);
  const b = toRadians(to.latitude);
  const delta = toRadians(to.longitude - from.longitude);
  return (Math.atan2(Math.sin(delta) * Math.cos(b), Math.cos(a) * Math.sin(b) - Math.sin(a) * Math.cos(b) * Math.cos(delta)) * 180 / Math.PI + 360) % 360;
}

const offsetPoint = (origin, east, north) => (east === 0 && north === 0 ? { ...origin } : destinationPoint(origin, Math.atan2(east, north) * 180 / Math.PI, Math.hypot(east, north)));

/**
 * Where the handoff puts the Listener and Source, from the current ones (with their heights in
 * `current.heightsMetres`). With a place, the Listener goes where the sound was heard, at its
 * height; without one, it stays. The Source goes the way the sound came from, at its distance along
 * the ground and as high above the Listener as the arrival's elevation makes it; without an arrival
 * it keeps its bearing, distance, and height. `moved` tells whether the Listener changed place.
 */
export function handoffPlacement(handoff, current) {
  const { place, listener: heard, arrival } = handoff;
  const listener = place
    ? offsetPoint({ latitude: place.latitudeDegrees, longitude: place.longitudeDegrees }, heard.positionMetres.east, heard.positionMetres.north)
    : { ...current.listener };
  const currentMetres = distanceMetres(current.listener, current.source);
  const source = arrival
    ? destinationPoint(listener, arrival.azimuthDegrees, (arrival.distanceMetres ?? currentMetres) * Math.cos(toRadians(arrival.elevationDegrees)))
    : currentMetres > 0 ? destinationPoint(listener, bearingDegrees(current.listener, current.source), currentMetres) : { ...listener };
  const listenerHeightMetres = place ? heard.heightAboveGroundMetres : current.heightsMetres?.listener ?? heard.heightAboveGroundMetres;
  const sourceHeightMetres = arrival
    ? listenerHeightMetres + (arrival.distanceMetres ?? currentMetres) * Math.sin(toRadians(arrival.elevationDegrees))
    : current.heightsMetres?.source ?? listenerHeightMetres;
  return { listener, source, listenerHeightMetres, sourceHeightMetres: Math.max(0, sourceHeightMetres), moved: Boolean(place) };
}

/** The air path whose absorption the sound already holds, metres: the distance it came, when it says the air is in it. */
export const handoffAirMetres = handoff => (handoff.content.includes.includes('air-absorption') ? handoff.arrival?.distanceMetres ?? 0 : 0);

/**
 * The handed-over sounds in a package's files ([{ name, data }]): every JSON file that is a handoff,
 * with the WAV its `audio.file` names. Other files are passed over.
 */
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
