import sdl from '@kmamal/sdl';
import { initResampler, resampleS16Stereo } from 'romdev-audio-resampler';

// The SDL device always opens at this fixed integer rate; cores at any other rate
// (incl. fractional ones) are resampled up/down to it — the way a libretro frontend
// resamples the core's stream to its output device instead of retuning the device.
const DEVICE_RATE = 48000;

export class AudioBridge {
  constructor() {
    this.device = null;
    this.sampleRate = DEVICE_RATE;
    this.coreRate = DEVICE_RATE;
    this.needsResample = false;
    this.resamplerReady = false;
    this.initialized = false;
  }

  async init(sampleRate, format = 's16') {
    // Open the device at a FIXED integer rate. Cores report their native rate — often
    // a clean 32–48 kHz, but sometimes fractional (e.g. the GameTank ACP at ~13983 Hz,
    // which SDL can't open directly: "frequency must be an integer"). Instead of
    // rounding the device rate to the core (which drifts), we keep the device at 48 kHz
    // and resample the core's S16 stream to it in onAudioBatch.
    this.coreRate = sampleRate;
    this.sampleRate = DEVICE_RATE;
    this.format = format;

    // Resampling applies only to the S16 libretro path. wasmcart F32 carts run their
    // own rate and go straight through. Skip when the core is already at the device rate.
    this.needsResample = format === 's16' && Math.round(sampleRate) !== DEVICE_RATE;
    if (this.needsResample) {
      // If the wasm resampler fails to load, degrade gracefully: fall back to opening
      // the device at the (rounded) core rate and passing audio through unresampled.
      this.resamplerReady = await initResampler();
      if (!this.resamplerReady) {
        this.needsResample = false;
        this.sampleRate = Math.round(sampleRate);
      }
    }

    this.device = sdl.audio.openDevice({ type: 'playback' }, {
      channels: 2,
      frequency: this.sampleRate,
      format: format,  // 's16' (default/libretro) or 'f32' (wasmcart F32 carts)
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
    let buffer = Buffer.from(wasmModule.HEAPU8.buffer, byteOffset, byteLength);

    // Resample the core's S16 stream to the device rate (returns a fresh Buffer). When
    // no resampling is needed we enqueue the WASM view directly — no conversion.
    if (this.needsResample) {
      buffer = resampleS16Stereo(buffer, this.coreRate, this.sampleRate);
    }

    this.device.enqueue(buffer);
    // Remote play taps the same PCM that goes to the speakers.
    if (this.onPcm) this.onPcm(buffer, this.sampleRate);

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
    if (this.onPcm) this.onPcm(buffer, this.sampleRate);
  }

  /** Push externally-produced PCM (remote play guest) straight to the device. */
  enqueuePcm(buffer) {
    if (!this.initialized || !buffer?.length) return;
    this.device.enqueue(Buffer.from(buffer));
  }

  destroy() {
    if (this.device) {
      this.device.close();
      this.device = null;
    }
    this.initialized = false;
  }
}
