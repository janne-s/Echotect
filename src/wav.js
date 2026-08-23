export const WAV_SAMPLE_RATE = 48000;
export const WAV_CHANNELS = 2;
export const WAV_FORMAT = 'ieee-float32';

const BYTES_PER_SAMPLE = 4;
const HEADER_BYTES = 44;
const FORMAT_CODE_IEEE_FLOAT = 3;
const RIFF_MAXIMUM_BYTES = 0xffffffff;

export function wavByteLength(frameCount) {
  return HEADER_BYTES + frameCount * WAV_CHANNELS * BYTES_PER_SAMPLE;
}

export function encodeFloat32Wav(channels, sampleRate = WAV_SAMPLE_RATE) {
  if (!Array.isArray(channels) || channels.length !== WAV_CHANNELS) throw new Error('WAV export requires exactly two channels.');
  const frameCount = channels[0]?.length;
  if (!Number.isInteger(frameCount) || channels.some(channel => !(channel instanceof Float32Array) || channel.length !== frameCount)) {
    throw new Error('WAV channels must be equal-length Float32Array values.');
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error('WAV sample rate must be a positive integer.');
  if (wavByteLength(frameCount) - 8 > RIFF_MAXIMUM_BYTES) throw new Error('WAV export exceeds the RIFF 4 GB size limit. Shorten the source audio or response duration.');

  const frameBytes = WAV_CHANNELS * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(wavByteLength(frameCount));
  const view = new DataView(buffer);
  const writeText = (offset, value) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  writeText(0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, FORMAT_CODE_IEEE_FLOAT, true);
  view.setUint16(22, WAV_CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * frameBytes, true);
  view.setUint16(32, frameBytes, true);
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true);
  writeText(36, 'data');
  view.setUint32(40, frameCount * frameBytes, true);
  let offset = HEADER_BYTES;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (const channel of channels) {
      view.setFloat32(offset, channel[frame], true);
      offset += BYTES_PER_SAMPLE;
    }
  }
  return buffer;
}
