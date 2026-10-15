export const clampToRange = (value, { minimum, maximum }) => Math.max(minimum, Math.min(maximum, value));

export function boundedValue(value, range) {
  const number = typeof value === 'string' ? Number(value.trim() || NaN) : value;
  return clampToRange(Number.isFinite(number) ? number : range.fallback, range);
}
