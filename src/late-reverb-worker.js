import { distanceMetres } from './geo.js';
import { synthesizeLateReverb } from './late-reverb.js';

self.addEventListener('message', event => {
  try {
    const channels = synthesizeLateReverb({ ...event.data, distanceMetres });
    self.postMessage({ channels: channels.map(channel => channel.buffer) }, channels.map(channel => channel.buffer));
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
