export const WAV_SAMPLE_RATE = 48000;
export const WAV_CHANNELS = 2;
export const WAV_FORMAT = 'ieee-float32';

export function wavByteLength(frameCount, channelCount = WAV_CHANNELS) {
  return 44 + frameCount * channelCount * 4;
}

export function encodeFloat32Wav(channels, sampleRate = WAV_SAMPLE_RATE) {
  if (!Array.isArray(channels) || channels.length !== WAV_CHANNELS) throw new Error('WAV export requires exactly two channels.');
  const frameCount = channels[0]?.length;
  if (!Number.isInteger(frameCount) || channels.some(channel => !(channel instanceof Float32Array) || channel.length !== frameCount)) {
    throw new Error('WAV channels must be equal-length Float32Array values.');
  }
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error('WAV sample rate must be a positive integer.');
  if (wavByteLength(frameCount, channels.length) - 8 > 0xffffffff) throw new Error('WAV export exceeds the RIFF 4 GB size limit. Shorten the source audio or response duration.');

  const buffer = new ArrayBuffer(wavByteLength(frameCount, channels.length));
  const view = new DataView(buffer);
  const writeText = (offset, value) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  writeText(0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels.length * 4, true);
  view.setUint16(32, channels.length * 4, true);
  view.setUint16(34, 32, true);
  writeText(36, 'data');
  view.setUint32(40, frameCount * channels.length * 4, true);
  let offset = 44;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (const channel of channels) {
      view.setFloat32(offset, channel[frame], true);
      offset += 4;
    }
  }
  return buffer;
}
