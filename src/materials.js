export const MATERIAL_ATTENUATION_DB = Object.freeze({
  generic: 0,
  concrete: -1,
  glass: -2,
  brick: -3,
  stone: -2,
  metal: 0,
  wood: -5,
  vegetation: -10
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
