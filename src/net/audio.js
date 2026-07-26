// Remote play audio pipeline.
//
// network.md's design is s16 stereo → mono → downsample → opus → ~1-2 KB/s.
// This ships the same shape with deflate instead of opus: no native/wasm codec
// dependency, and at 12 kHz mono the deflated stream lands around 8-14 KB/s —
// more than opus would use, still trivial next to the video, and it keeps the
// "lo-fi is part of the charm" character the doc asks for. Swapping deflate
// for opus later only touches encodeChunk/decodeChunk.
import { deflateSync, inflateSync } from 'node:zlib';

export const REMOTE_RATE = 12000; // mono, 16-bit

/**
 * Stereo s16 at `srcRate` → mono s16 at REMOTE_RATE.
 * Averaging the pair keeps centre-panned game audio intact; a plain
 * nearest-sample step is enough at this bandwidth.
 */
export function downmix(buffer, srcRate) {
  const src = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length >> 1);
  const frames = src.length >> 1; // stereo
  const ratio = srcRate / REMOTE_RATE;
  const outFrames = Math.max(0, Math.floor(frames / ratio));
  const out = new Int16Array(outFrames);
  for (let i = 0; i < outFrames; i++) {
    const s = Math.min(frames - 1, Math.round(i * ratio)) * 2;
    out[i] = (src[s] + src[s + 1]) >> 1;
  }
  return out;
}

/** Mono s16 at REMOTE_RATE → stereo s16 at `dstRate`, for playback. */
export function upmix(mono, dstRate) {
  const ratio = dstRate / REMOTE_RATE;
  const outFrames = Math.max(0, Math.floor(mono.length * ratio));
  const out = new Int16Array(outFrames * 2);
  for (let i = 0; i < outFrames; i++) {
    const v = mono[Math.min(mono.length - 1, Math.floor(i / ratio))];
    out[i * 2] = v;
    out[i * 2 + 1] = v;
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

// IMA ADPCM: 16-bit samples → 4 bits each, a flat 4:1 win. General-purpose
// compressors do almost nothing for game audio (measured: deflate on real
// gameplay saved ~0%, because the signal is noise-like), whereas ADPCM is
// designed for exactly this and needs no dependency. At 12 kHz mono that's
// ~6 KB/s — the "walkie-talkie" character network.md asks for.
const STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
  253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
  3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];
const INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

function clamp16(v) {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

/** @returns {{data: Buffer, predictor: number, index: number}} */
export function adpcmEncode(mono, state = { predictor: 0, index: 0 }) {
  let { predictor, index } = state;
  const out = Buffer.alloc((mono.length + 1) >> 1);
  for (let i = 0; i < mono.length; i++) {
    const step = STEP_TABLE[index];
    let diff = mono[i] - predictor;
    let code = 0;
    if (diff < 0) { code = 8; diff = -diff; }
    let delta = step >> 3;
    if (diff >= step) { code |= 4; diff -= step; delta += step; }
    if (diff >= step >> 1) { code |= 2; diff -= step >> 1; delta += step >> 1; }
    if (diff >= step >> 2) { code |= 1; delta += step >> 2; }
    predictor = clamp16(predictor + (code & 8 ? -delta : delta));
    index = Math.max(0, Math.min(88, index + INDEX_TABLE[code]));
    if (i & 1) out[i >> 1] |= code << 4;
    else out[i >> 1] = code;
  }
  return { data: out, predictor, index };
}

export function adpcmDecode(data, samples, state = { predictor: 0, index: 0 }) {
  let { predictor, index } = state;
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    const code = i & 1 ? data[i >> 1] >> 4 : data[i >> 1] & 0x0f;
    const step = STEP_TABLE[index];
    let delta = step >> 3;
    if (code & 4) delta += step;
    if (code & 2) delta += step >> 1;
    if (code & 1) delta += step >> 2;
    predictor = clamp16(predictor + (code & 8 ? -delta : delta));
    index = Math.max(0, Math.min(88, index + INDEX_TABLE[code]));
    out[i] = predictor;
  }
  return { samples: out, predictor, index };
}

/**
 * Encode one packet. Each packet carries its own start state so a dropped
 * packet costs one click instead of desynchronising the whole stream.
 */
export function encodeChunk(mono, state = { predictor: 0, index: 0 }) {
  const enc = adpcmEncode(mono, state);
  return {
    b: enc.data.toString('base64'),
    n: mono.length,
    p: state.predictor,
    x: state.index,
    next: { predictor: enc.predictor, index: enc.index },
  };
}

export function decodeChunk(packet) {
  // Legacy/deflate form (a plain base64 string) still decodes, so a mismatched
  // guest and host don't simply go silent.
  if (typeof packet === 'string') {
    const raw = inflateSync(Buffer.from(packet, 'base64'));
    return new Int16Array(raw.buffer, raw.byteOffset, raw.length >> 1);
  }
  const data = Buffer.from(packet.b, 'base64');
  return adpcmDecode(data, packet.n, { predictor: packet.p ?? 0, index: packet.x ?? 0 }).samples;
}

/**
 * Accumulates mono samples and emits fixed-size packets, so audio goes out in
 * steady chunks rather than at whatever cadence the core happens to call back.
 */
export class AudioPacketizer {
  constructor({ samplesPerPacket = REMOTE_RATE / 20, onPacket } = {}) {
    this.samplesPerPacket = samplesPerPacket; // 50ms at 12kHz
    this.onPacket = onPacket;
    this.pending = new Int16Array(samplesPerPacket * 4);
    this.have = 0;
  }

  push(mono) {
    let offset = 0;
    while (offset < mono.length) {
      const room = this.samplesPerPacket - this.have;
      const take = Math.min(room, mono.length - offset);
      this.pending.set(mono.subarray(offset, offset + take), this.have);
      this.have += take;
      offset += take;
      if (this.have >= this.samplesPerPacket) {
        this.onPacket?.(this.pending.subarray(0, this.samplesPerPacket));
        this.have = 0;
      }
    }
  }
}
