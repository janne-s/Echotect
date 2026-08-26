import { isValidCoordinate, metresPerDegreeLatitude, metresPerDegreeLongitude } from './geo.js';

export const MINIMUM_STRUCTURE_VERTICES = 3;

const radians = degrees => degrees * Math.PI / 180;

export function localPoint(center, point) {
  return {
    x: (point.longitude - center.longitude) * metresPerDegreeLongitude(center.latitude),
    y: (point.latitude - center.latitude) * metresPerDegreeLatitude()
  };
}

export function geographicPoint(center, { x, y }) {
  return {
    latitude: center.latitude + y / metresPerDegreeLatitude(),
    longitude: center.longitude + x / metresPerDegreeLongitude(center.latitude)
  };
}

export function rotateLocal({ x, y }, rotationDegrees) {
  const angle = radians(rotationDegrees);
  return { x: x * Math.cos(angle) + y * Math.sin(angle), y: -x * Math.sin(angle) + y * Math.cos(angle) };
}

export function createRectangleVertices(widthMetres, lengthMetres) {
  const halfWidth = widthMetres / 2;
  const halfLength = lengthMetres / 2;
  return [
    { x: -halfWidth, y: -halfLength }, { x: halfWidth, y: -halfLength },
    { x: halfWidth, y: halfLength }, { x: -halfWidth, y: halfLength }
  ];
}

export function structureVertices(structure) {
  return structure.verticesMetres.map(point => geographicPoint(structure.center, rotateLocal(point, structure.rotationDegrees)));
}

export function structureRing(structure) {
  const vertices = structureVertices(structure).map(point => [point.longitude, point.latitude]);
  return [...vertices, vertices[0]];
}

export function structureWalls(structure) {
  const ring = structureRing(structure);
  return ring.slice(1).map((point, index) => ({
    edge: [ring[index], point], key: `structure-${structure.id}-${index}`, ring,
    facadeMaterial: structure.material === 'inherit' ? null : structure.material, structureId: structure.id
  }));
}

export function pointInStructureSpace(structure, point) {
  return rotateLocal(localPoint(structure.center, point), -structure.rotationDegrees);
}

export function moveEdgeVertices(vertices, edgeIndex, delta) {
  const next = vertices.map(point => ({ ...point }));
  const nextIndex = (edgeIndex + 1) % next.length;
  [edgeIndex, nextIndex].forEach(index => {
    next[index].x += delta.x;
    next[index].y += delta.y;
  });
  return next;
}

export function insertVertex(vertices, edgeIndex, point) {
  const next = vertices.map(vertex => ({ ...vertex }));
  next.splice(edgeIndex + 1, 0, { ...point });
  return next;
}

export function removeVertex(vertices, vertexIndex) {
  if (vertices.length <= MINIMUM_STRUCTURE_VERTICES) return vertices.map(point => ({ ...point }));
  return vertices.filter((_, index) => index !== vertexIndex).map(point => ({ ...point }));
}

export function validStructure(value) {
  return typeof value?.id === 'string' && Boolean(value.id) && isValidCoordinate(value.center)
    && Array.isArray(value.verticesMetres) && value.verticesMetres.length >= MINIMUM_STRUCTURE_VERTICES
    && value.verticesMetres.length <= 256 && value.verticesMetres.every(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))
    && Number.isFinite(value.rotationDegrees) && value.rotationDegrees >= -180 && value.rotationDegrees <= 180;
}
