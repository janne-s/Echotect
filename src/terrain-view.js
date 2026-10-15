import { floorOutline } from './terrain-space.js';

const LIGHT = Object.freeze({ x: -.5, y: .5, z: Math.SQRT1_2 });
const SHADE_MINIMUM = 40;
const SHADE_RANGE = 200;
const OUTSIDE_CAVITY_SHADE = .3;

export function hillshadeDataUrl(frame) {
  const { columns, rows, values, gradientX, gradientY, mode, floor } = frame;
  const canvas = document.createElement('canvas');
  canvas.width = columns;
  canvas.height = rows;
  const context = canvas.getContext('2d');
  const image = context.createImageData(columns, rows);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column;
      const length = Math.hypot(gradientX[index], gradientY[index], 1);
      const light = Math.max(0, (-gradientX[index] * LIGHT.x - gradientY[index] * LIGHT.y + LIGHT.z) / length);
      const cavity = mode === 'interior' && values[index] <= floor ? OUTSIDE_CAVITY_SHADE : 1;
      const shade = Math.round((SHADE_MINIMUM + SHADE_RANGE * light) * cavity);
      const pixel = ((rows - 1 - row) * columns + column) * 4;
      image.data[pixel] = shade;
      image.data[pixel + 1] = shade;
      image.data[pixel + 2] = shade;
      image.data[pixel + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

export const footprintCoordinates = frame => frame.footprint().map(point => [point.longitude, point.latitude]);

export function footprintGeoJson(frame) {
  const corners = footprintCoordinates(frame);
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...corners, corners[0]]] } };
}

export function floorOutlineGeoJson(frame) {
  if (frame.mode !== 'interior') return { type: 'FeatureCollection', features: [] };
  return {
    type: 'Feature', properties: {},
    geometry: { type: 'MultiLineString', coordinates: floorOutline(frame).map(segment => segment.map(point => [point.longitude, point.latitude])) }
  };
}
