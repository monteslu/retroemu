import sdl from '@kmamal/sdl';

export class AudioBridge {
  constructor() {
    this.device = null;
    this.sampleRate = 48000;
    this.initialized = false;
  }

  async init(sampleRate) {
    this.sampleRate = sampleRate;

    // Open SDL audio device - S16 stereo, matching libretro's format
    this.device = sdl.audio.openDevice({ type: 'playback' }, {
      channels: 2,
      frequency: sampleRate,
      format: 's16',  // Signed 16-bit - matches libretro exactly
    });

    this.device.play();
    this.initialized = true;
  }

  // Called from libretro audio_sample_batch callback
  // dataPtr points to interleaved int16 stereo samples in WASM heap
  onAudioBatch(wasmModule, dataPtr, frames) {
    if (!this.initialized) return frames;

    // Get the raw bytes directly from WASM memory
    const byteOffset = dataPtr;
    const byteLength = frames * 2 * 2; // frames * 2 channels * 2 bytes per sample

    // Create a buffer view of the WASM memory
    const buffer = Buffer.from(wasmModule.HEAPU8.buffer, byteOffset, byteLength);

    // Queue directly to SDL - no conversion needed!
    this.device.enqueue(buffer);

    return frames;
  }

  // Called from libretro audio_sample callback (single stereo sample)
  onAudioSample(left, right) {
    if (!this.initialized) return;

    // Create a small buffer for one stereo sample
    const buffer = Buffer.alloc(4);
    buffer.writeInt16LE(left, 0);
    buffer.writeInt16LE(right, 2);

    this.device.enqueue(buffer);
  }

  destroy() {
    if (this.device) {
      this.device.close();
      this.device = null;
    }
    this.initialized = false;
  }
}
