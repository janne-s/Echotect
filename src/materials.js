/** Energy absorption coefficients at 125, 250, 500, 1k, 2k, 4k, and 8k Hz. */
export const MATERIAL_ABSORPTION = Object.freeze({
  generic: Object.freeze([.05, .06, .07, .08, .10, .12, .15]),
  concrete: Object.freeze([.02, .02, .03, .03, .03, .04, .07]),
  glass: Object.freeze([.18, .06, .04, .03, .02, .02, .02]),
  brick: Object.freeze([.03, .03, .04, .05, .07, .09, .12]),
  stone: Object.freeze([.02, .02, .02, .03, .04, .05, .06]),
  metal: Object.freeze([.01, .01, .01, .01, .02, .02, .03]),
  wood: Object.freeze([.15, .15, .11, .10, .07, .06, .06]),
  vegetation: Object.freeze([.10, .15, .25, .40, .55, .65, .75])
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
  vegetation: 'Vegetation'
});

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
