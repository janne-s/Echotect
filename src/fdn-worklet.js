class EchotectFdnProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const settings = options.processorOptions;
    this.buffers = settings.delaySamples.map(length => new Float32Array(length));
    this.indices = settings.delaySamples.map(() => 0);
    this.filtered = settings.delaySamples.map(() => 0);
    this.feedback = settings.feedback;
    this.damping = settings.damping;
    this.density = settings.density;
    this.outputGains = settings.outputGains;
    this.tailSamples = settings.tailSamples;
    this.silentSamples = 0;
    this.receivedSignal = false;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const frames = output[0].length;
    for (let frame = 0; frame < frames; frame += 1) {
      const dry = input.length ? input.reduce((sum, channel) => sum + (channel[frame] || 0), 0) / input.length : 0;
      if (Math.abs(dry) > 1e-6) {
        this.receivedSignal = true;
        this.silentSamples = 0;
      } else if (this.receivedSignal) {
        this.silentSamples += 1;
      }
      const taps = this.buffers.map((buffer, index) => {
        const value = buffer[this.indices[index]];
        this.filtered[index] += (value - this.filtered[index]) * (1 - this.damping * .94);
        return this.filtered[index];
      });

      // Normalized eight-channel Hadamard feedback matrix.
      const mixed = taps.slice();
      for (let span = 1; span < mixed.length; span *= 2) {
        for (let start = 0; start < mixed.length; start += span * 2) {
          for (let offset = 0; offset < span; offset += 1) {
            const a = mixed[start + offset];
            const b = mixed[start + offset + span];
            mixed[start + offset] = a + b;
            mixed[start + offset + span] = a - b;
          }
        }
      }
      const normalization = 1 / Math.sqrt(mixed.length);
      this.buffers.forEach((buffer, index) => {
        const injected = dry * (.12 + this.density * .2) * (index % 2 ? -1 : 1);
        buffer[this.indices[index]] = injected + mixed[index] * normalization * this.feedback[index];
        this.indices[index] = (this.indices[index] + 1) % buffer.length;
      });

      output[0][frame] = taps.reduce((sum, tap, index) => sum + tap * this.outputGains[index][0], 0) * .16;
      if (output[1]) output[1][frame] = taps.reduce((sum, tap, index) => sum + tap * this.outputGains[index][1], 0) * .16;
    }
    return !this.receivedSignal || this.silentSamples < this.tailSamples;
  }
}

registerProcessor('echotect-fdn', EchotectFdnProcessor);
