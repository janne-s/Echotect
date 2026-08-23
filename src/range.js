/**
 * Numeric bounds shared by levels, headings, settings, and gains. A range is
 * { minimum, maximum } plus an optional fallback used when a stored or entered value is unusable.
 */
export const clampToRange = (value, { minimum, maximum }) => Math.max(minimum, Math.min(maximum, value));

export function boundedValue(value, range) {
  const number = typeof value === 'string' ? Number(value.trim() || NaN) : value;
  return clampToRange(Number.isFinite(number) ? number : range.fallback, range);
}
