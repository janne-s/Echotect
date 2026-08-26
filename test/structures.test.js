import test from 'node:test';
import assert from 'node:assert/strict';
import { reflectionField, wallReflectionCandidate } from '../src/echo-geometry.js';
import { distanceMetres } from '../src/geo.js';
import { createRectangleVertices, insertVertex, moveEdgeVertices, removeVertex, structureVertices, structureWalls } from '../src/structures.js';

const structure = { id: 's1', center: { latitude: 60, longitude: 24 }, verticesMetres: createRectangleVertices(20, 10), rotationDegrees: 0, material: 'concrete' };

test('rectangle geometry produces four stable closed walls with requested metre dimensions', () => {
  const corners = structureVertices(structure);
  const walls = structureWalls(structure);
  assert.equal(corners.length, 4);
  assert.equal(walls.length, 4);
  assert.deepEqual(walls[0].edge[0], walls[3].edge[1]);
  assert.equal(walls[0].ring.length, 5);
  assert.equal(walls[0].key, 'structure-s1-0');
});

test('structure walls feed the Echo field as exterior reflecting surfaces', () => {
  const walls = structureWalls(structure);
  const source = { latitude: 60 - 20 / 110540, longitude: 24 };
  const listener = { latitude: 60 - 30 / 110540, longitude: 24 };
  const field = reflectionField({ source, listener, walls, radiusMetres: 100 });
  assert.ok(walls.some(wall => wallReflectionCandidate(field, wall, distanceMetres)));
});

test('polygon edges and vertices can be edited without changing unrelated vertices', () => {
  const inserted = insertVertex(structure.verticesMetres, 0, { x: 0, y: -5 });
  assert.equal(inserted.length, 5);
  const moved = moveEdgeVertices(inserted, 1, { x: 3, y: 2 });
  assert.deepEqual(moved[0], inserted[0]);
  assert.deepEqual(moved[1], { x: 3, y: -3 });
  assert.deepEqual(moved[2], { x: 13, y: -3 });
  assert.equal(removeVertex(moved, 1).length, 4);
  assert.equal(removeVertex(createRectangleVertices(2, 2).slice(0, 3), 1).length, 3);
});
