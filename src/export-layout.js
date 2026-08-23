import { WAV_SAMPLE_RATE } from './wav.js';

/** A rendered FDN impulse response runs past its nominal tail so the decay is not truncated. */
export const FDN_IR_DURATION_FACTOR = 1.25;

/** Fixed share of each late field in the composed IR, wet render, and manifest description. */
const LATE_FIELD_GAIN = Object.freeze({ convolution: .7, fdn: .65 });

export const lateFieldGain = lateMode => lateMode === 'fdn' ? LATE_FIELD_GAIN.fdn : LATE_FIELD_GAIN.convolution;

export const fdnResponseSeconds = settings => settings.fdnTailSeconds * FDN_IR_DURATION_FACTOR;

/**
 * The frame counts of every export, derived once from the arrival events so the manifest, the
 * export size estimate, and the rendered WAV files can never describe different files.
 */
export function exportFrameLayout({ settings, earlyFrames, directFrame, inputFrames, sampleRate = WAV_SAMPLE_RATE }) {
  const earlyTailFrames = earlyFrames.reduce((frames, frame) => Math.max(frames, frame + 1), 0);
  const convolutionIrFrames = Math.max(Math.ceil(settings.durationSeconds * sampleRate), earlyTailFrames);
  const fdnIrFrames = Math.max(Math.ceil(fdnResponseSeconds(settings) * sampleRate), earlyTailFrames);
  return {
    convolutionIrFrames,
    fdnIrFrames,
    timelineFrames: Math.max(1, inputFrames + Math.max(convolutionIrFrames, fdnIrFrames) - 1, directFrame + inputFrames)
  };
}
