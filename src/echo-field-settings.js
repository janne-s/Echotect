import { AUDIBILITY_THRESHOLD_DB } from './audio-model.js';
import { boundedValue } from './range.js';

export const LATE_MODES = Object.freeze(['convolution', 'fdn']);
export const DEFAULT_LATE_MODE = 'convolution';
export const POINT_MODES = Object.freeze(['geometric', 'persistent']);
export const DEFAULT_POINT_MODE = 'persistent';
export const AIR_MODES = Object.freeze(['standard', 'custom', 'off']);
export const DEFAULT_AIR_MODE = 'standard';

/**
 * The one description of every echo field setting: its bounds, its slider step, and the value used
 * when a stored or entered value is missing or unusable. The dialog controls, the stored workspace,
 * and the project manifest all derive from this table.
 */
export const ECHO_FIELD_SETTINGS = Object.freeze({
  durationSeconds: {
    minimum: 1,
    maximum: 60,
    step: 1,
    fallback: 10 },
  maxSurfaces: {
    minimum: 8,
    maximum: 512,
    step: 1,
    fallback: 48,
    integer: true },
  pointPathLimit: {
    minimum: 32,
    maximum: 4096,
    step: 32,
    fallback: 512,
    integer: true },
  pointMaxBounces: {
    minimum: 1,
    maximum: 32,
    step: 1,
    fallback: 6,
    integer: true },
  pointPersistence: {
    minimum: 0,
    maximum: .95,
    step: .05,
    fallback: .65 },
  geometricSpreadingAmount: {
    minimum: 0,
    maximum: 1,
    step: .05,
    fallback: 1 },
  airTemperatureCelsius: {
    minimum: -20,
    maximum: 50,
    step: 1,
    fallback: 20 },
  airHumidityPercent: {
    minimum: 10,
    maximum: 100,
    step: 1,
    fallback: 50 },
  airPressureKpa: {
    minimum: 80,
    maximum: 110,
    step: .1,
    fallback: 101.3 },
  airAbsorptionAmount: {
    minimum: 0,
    maximum: 2,
    step: .05,
    fallback: 1 },
  materialColorationAmount: {
    minimum: 0,
    maximum: 2,
    step: .05,
    fallback: 1 },
  lateFieldLevelDb: {
    minimum: -12,
    maximum: 6,
    step: 1,
    fallback: 2 },
  lateWalks: {
    minimum: 256,
    maximum: 65536,
    step: 256,
    fallback: 8192,
    integer: true },
  maxBounces: {
    minimum: 2,
    maximum: 128,
    step: 1,
    fallback: 32,
    integer: true },
  cutoffDb: {
    minimum: -120,
    maximum: -30,
    step: 1,
    fallback: AUDIBILITY_THRESHOLD_DB },
  tailPersistence: {
    minimum: .1,
    maximum: 1,
    step: .05,
    fallback: .6 },
  fdnTailSeconds: {
    minimum: 1,
    maximum: 60,
    step: .5,
    fallback: 8 },
  fdnDensity: {
    minimum: .1,
    maximum: 1,
    step: .05,
    fallback: .7 },
  fdnDamping: {
    minimum: .1,
    maximum: 1,
    step: .05,
    fallback: .55 },
  geometryInfluence: {
    minimum: 0,
    maximum: 1,
    step: .05,
    fallback: .7 }
});

/** Accepts stored JSON or raw input values and always returns a complete, in-range setting set. */
export function normalizeEchoFieldSettings(values) {
  const settings = {};
  for (const [name, spec] of Object.entries(ECHO_FIELD_SETTINGS)) {
    const value = boundedValue(values?.[name], spec);
    settings[name] = spec.integer ? Math.round(value) : value;
  }
  settings.lateMode = LATE_MODES.includes(values?.lateMode) ? values.lateMode : DEFAULT_LATE_MODE;
  settings.pointMode = POINT_MODES.includes(values?.pointMode) ? values.pointMode : DEFAULT_POINT_MODE;
  settings.airMode = AIR_MODES.includes(values?.airMode) ? values.airMode : DEFAULT_AIR_MODE;
  settings.buildingOcclusion = values?.buildingOcclusion !== false;
  return settings;
}

export const DEFAULT_ECHO_FIELD_SETTINGS = Object.freeze(normalizeEchoFieldSettings({}));
