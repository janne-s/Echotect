const MATERIAL_BAND_HZ = Object.freeze([125, 250, 500, 1000, 2000, 4000, 8000]);

/** Delany–Bazley one-parameter model, normal incidence. */
export function groundAbsorption(frequencyHz, flowResistivityKpaSecondsPerSquareMetre) {
  const ratio = frequencyHz / flowResistivityKpaSecondsPerSquareMetre;
  const resistance = 1 + 9.08 * ratio ** -.75;
  const reactance = 11.9 * ratio ** -.73;
  const reflectionSquared = ((resistance - 1) ** 2 + reactance ** 2) / ((resistance + 1) ** 2 + reactance ** 2);
  return 1 - reflectionSquared;
}

/** Mean of each FHWA TNM ground-type range (Embleton, Piercy & Daigle 1983), kPa·s/m². */
export const GROUND_FLOW_RESISTIVITY = Object.freeze({
  snow: 20,
  forestFloor: 50,
  grass: 212.5,
  soil: 278,
  stonyGround: 550
});

const groundBands = flowResistivity => Object.freeze(MATERIAL_BAND_HZ.map(frequency => groundAbsorption(frequency, flowResistivity)));

export const MATERIAL_ABSORPTION = Object.freeze({
  generic: Object.freeze([.05, .06, .07, .08, .10, .12, .15]),
  concrete: Object.freeze([.02, .02, .03, .03, .03, .04, .07]),
  glass: Object.freeze([.18, .06, .04, .03, .02, .02, .02]),
  brick: Object.freeze([.03, .03, .04, .05, .07, .09, .12]),
  stone: Object.freeze([.02, .02, .02, .03, .04, .05, .06]),
  metal: Object.freeze([.01, .01, .01, .01, .02, .02, .03]),
  wood: Object.freeze([.15, .15, .11, .10, .07, .06, .06]),
  vegetation: Object.freeze([.10, .15, .25, .40, .55, .65, .75]),
  ...Object.fromEntries(Object.entries(GROUND_FLOW_RESISTIVITY).map(([material, flowResistivity]) => [material, groundBands(flowResistivity)]))
});

export const MATERIAL_LABELS = Object.freeze({
  inherit: 'Global',
  generic: 'Generic',
  concrete: 'Concrete',
  glass: 'Glass',
  brick: 'Brick',
  stone: 'Stone',
  metal: 'Metal',
  wood: 'Wood',
  vegetation: 'Vegetation',
  snow: 'Snow',
  forestFloor: 'Forest floor',
  grass: 'Grass',
  soil: 'Soil',
  stonyGround: 'Stony ground'
});

export const DEFAULT_TERRAIN_MATERIAL = 'stone';

export function normalizeFacadeMaterial(value) {
  const material = String(value ?? '').toLowerCase();
  if (/concrete|cement|plaster/.test(material)) return 'concrete';
  if (/glass/.test(material)) return 'glass';
  if (/brick/.test(material)) return 'brick';
  if (/stone|rock/.test(material)) return 'stone';
  if (/metal|steel|aluminium|aluminum/.test(material)) return 'metal';
  if (/wood|timber/.test(material)) return 'wood';
  if (/vegetation|hedge|foliage/.test(material)) return 'vegetation';
  return null;
}

export function effectiveMaterial(reflector, globalMaterial) {
  return reflector.material && reflector.material !== 'inherit' ? reflector.material : globalMaterial;
}
