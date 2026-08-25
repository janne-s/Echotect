import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceMetres } from '../src/geo.js';
import { edgeKey, reflectionField, reflectorVisibilityGraph, wallReflectionCandidate } from '../src/echo-geometry.js';

const source = { latitude: -0.001, longitude: 0 };
const listener = { latitude: -0.001, longitude: 0.001 };
const ring = [[0, 0], [0.002, 0], [0.002, 0.001], [0, 0.001], [0, 0]];
const edge = [ring[0], ring[1]];
const wallOf = value => ({ edge: value, key: edgeKey(value), ring });
const candidateFor = ({ walls = [], radiusMetres = 500, target = edge, from = source, to = listener }) =>
  wallReflectionCandidate(reflectionField({ source: from, listener: to, walls, radiusMetres }), { edge: target, ring }, distanceMetres);

test('visible exterior wall produces a reflection candidate', () => {
  const walls = ring.slice(1).map((point, index) => wallOf([ring[index], point]));
  assert.ok(candidateFor({ walls }));
});

test('visible wall remains as diffuse when the exact reflection misses the segment', () => {
  const candidate = candidateFor({
    walls: [wallOf(edge)],
    from: { latitude: -0.001, longitude: 0.004 },
    to: { latitude: -0.001, longitude: 0.003 }
  });
  assert.equal(candidate?.kind, 'diffuse');
});

test('back wall is rejected when source and listener are on its interior side', () => {
  assert.equal(candidateFor({ target: [ring[2], ring[3]] }), null);
});

test('another wall blocking the path rejects the candidate', () => {
  const blocker = [[-0.001, -0.0005], [0.002, -0.0005]];
  assert.equal(candidateFor({ walls: [wallOf(edge), wallOf(blocker)] }), null);
});

test('a wall beyond the echo field radius contributes nothing', () => {
  assert.ok(candidateFor({ walls: [wallOf(edge)], radiusMetres: 500 }));
  assert.equal(candidateFor({ walls: [wallOf(edge)], radiusMetres: 20 }), null);
});

test('walls that cannot block a path do not change the result', () => {
  const distant = [[0.05, 0.05], [0.05, 0.06]];
  const withoutDistant = candidateFor({ walls: [wallOf(edge)] });
  const withDistant = candidateFor({ walls: [wallOf(edge), wallOf(distant)] });
  assert.deepEqual(withDistant, withoutDistant);
});

test('reflector visibility graph rejects a connection through a wall', () => {
  const reflectors = [
    { id: 'west', latitude: 0, longitude: -.001 },
    { id: 'east', latitude: 0, longitude: .001 }
  ];
  const blocker = [[0, -.001], [0, .001]];
  const open = reflectorVisibilityGraph(reflectionField({ source, listener, walls: [], radiusMetres: 500 }), reflectors);
  const blocked = reflectorVisibilityGraph(reflectionField({ source, listener, walls: [wallOf(blocker)], radiusMetres: 500 }), reflectors);
  assert.deepEqual(open.get('west'), ['east']);
  assert.deepEqual(blocked.get('west'), []);
});
