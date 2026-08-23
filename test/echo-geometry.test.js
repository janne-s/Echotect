import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceMetres } from '../src/geo.js';
import { edgeKey, wallReflectionCandidate } from '../src/echo-geometry.js';

const source = { latitude: -0.001, longitude: 0 };
const listener = { latitude: -0.001, longitude: 0.001 };
const ring = [[0, 0], [0.002, 0], [0.002, 0.001], [0, 0.001], [0, 0]];
const edge = [ring[0], ring[1]];
const obstacle = value => ({ edge: value, key: edgeKey(value) });

test('visible exterior wall produces a reflection candidate', () => {
  const candidate = wallReflectionCandidate({ edge, ring, source, listener, obstacles: ring.slice(1).map((point, index) => obstacle([ring[index], point])), radiusMetres: 500, distanceMetres });
  assert.ok(candidate);
});

test('visible wall remains as diffuse when the exact reflection misses the segment', () => {
  const offsetSource = { latitude: -0.001, longitude: 0.004 };
  const offsetListener = { latitude: -0.001, longitude: 0.003 };
  const candidate = wallReflectionCandidate({ edge, ring, source: offsetSource, listener: offsetListener, obstacles: [obstacle(edge)], radiusMetres: 500, distanceMetres });
  assert.equal(candidate?.kind, 'diffuse');
});

test('back wall is rejected when source and listener are on its interior side', () => {
  const backEdge = [ring[2], ring[3]];
  const candidate = wallReflectionCandidate({ edge: backEdge, ring, source, listener, obstacles: [], radiusMetres: 500, distanceMetres });
  assert.equal(candidate, null);
});

test('another wall blocking the path rejects the candidate', () => {
  const blocker = [[-0.001, -0.0005], [0.002, -0.0005]];
  const candidate = wallReflectionCandidate({ edge, ring, source, listener, obstacles: [obstacle(edge), obstacle(blocker)], radiusMetres: 500, distanceMetres });
  assert.equal(candidate, null);
});
