// GLRenderer + VideoOutput wiring, end to end.
//
// The assertions that matter are not "does a shader run" (probe-shader-chain
// covers that) but "does wiring it into the real video path break anything":
// the CPU frame callback feeds screenshots, remote play and the overlay, and
// a bad preset must never cost the user their game.
import gl from 'native-gles';
import path from 'node:path';
import { GLRenderer } from '../src/video/GLRenderer.js';
import { VideoOutput } from '../src/video/VideoOutput.js';
import { rgbaToPng } from '../src/control/png.js';

const CORPUS = process.argv[2]
  ?? '/tmp/claude-1000/-home-monteslu-code-cliemu/8d607e85-2b00-4f01-b123-94d31845fea9/scratchpad/glslsh';
const ROM = process.argv[3] ?? '/home/monteslu/code/cliemu/roms-real/gb/Tetris (World) (Rev 1).gb';
const PRESET = path.join(CORPUS, 'crt/crt-geom-mini.glslp');
const say = (q, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${q}${d ? ' — ' + d : ''}`); return ok; };
let fails = 0;

// ── GLRenderer in isolation ────────────────────────────────────────
const win = { pixelWidth: 640, pixelHeight: 480 };
const r = await GLRenderer.create({ window: win, presetPath: PRESET });
if (!say('GLRenderer.create succeeded', !!r)) process.exit(1);
if (!say('preset loaded', r.status().passes > 0, `${r.status().passes} pass(es)`)) fails++;

const W = 256; const H = 224;
const frame = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    frame[i] = (x * 7 + y * 3) & 255;
    frame[i + 1] = ((x * x / 64) + y) & 255;
    frame[i + 2] = ((x ^ y) * 3) & 255;
    frame[i + 3] = 255;
  }
}
const pristine = Uint8Array.from(frame);
r.render(frame, W, H); r.render(frame, W, H);
const out = new Uint8Array(640 * 480 * 4);
gl.glFinish(); gl.glReadPixels(0, 0, 640, 480, 0x1908, 0x1401, out);
let lit = 0; const colours = new Set();
for (let i = 0; i < out.length; i += 4) {
  if (out[i] || out[i + 1] || out[i + 2]) lit++;
  colours.add((out[i] << 16) | (out[i + 1] << 8) | out[i + 2]);
}
if (!say('GL presents real pixels', lit > 640 * 480 * 0.2 && colours.size > 8,
  `${lit} lit, ${colours.size} colours`)) fails++;
// Presentation must be READ-ONLY on the frame: screenshots read the same buffer.
if (!say('source buffer not mutated by presentation',
  Buffer.compare(Buffer.from(pristine), Buffer.from(frame)) === 0)) fails++;

const square = new Uint8Array(200 * 200 * 4).fill(255);
r.render(square, 200, 200);
gl.glFinish(); gl.glReadPixels(0, 0, 640, 480, 0x1908, 0x1401, out);
if (!say('letterboxes a square source', out[0] === 0 && out[1] === 0 && out[2] === 0,
  'corner pixel is black')) fails++;

const bad = r.setPreset('/nonexistent/nope.glslp');
if (!say('a bad preset reports an error', !!bad.error, (bad.error ?? '').slice(0, 44))) fails++;
if (!say('previous chain survives a failed swap', r.status().passes > 0)) fails++;
r.destroy();

// ── through the real VideoOutput, with a real game ─────────────────
const videoOutput = new VideoOutput({ video: 'none', shader: PRESET });
await videoOutput.init();
const { LibretroHost } = await import('../src/core/LibretroHost.js');
const { loadRom } = await import('../src/core/RomLoader.js');
const info = await loadRom(ROM);
const seen = []; let last = null;
videoOutput.onFrameCallback = (rgba, w, h) => {
  seen.push({ w, h, len: rgba.length });
  last = { rgba: Uint8Array.from(rgba), w, h };
};
const audioBridge = { init: async () => {}, onAudioBatch: () => 0, onAudioSample: () => {}, push: () => {}, write: () => {}, stop: () => {}, close: () => {} };
const host = new LibretroHost({
  videoOutput,
  audioBridge,
  inputManager: { poll: () => {}, getState: () => 0, isPressed: () => false, getAnalog: () => 0 },
  saveManager: { loadSRAM: async () => {}, saveSRAM: async () => {}, load: () => null, save: () => {} },
});
await host.loadAndStart(info.romPath, { saveDir: '/tmp', romData: info.data });
await new Promise((res) => setTimeout(res, 2500));

if (!say('frames delivered with a shader configured', seen.length > 30, `${seen.length}`)) fails++;
if (!say('callback buffers correctly sized', seen.every((f) => f.len === f.w * f.h * 4),
  `${seen.length} checked`)) fails++;
let png = null; let err = '';
try { png = rgbaToPng(last.rgba, last.w, last.h); } catch (e) { err = e.message; }
const isPng = !!png && png[0] === 0x89 && png[1] === 0x50;
if (!say('screenshot PNG still encodes', isPng,
  isPng ? `${png.length} bytes, ${last.w}x${last.h}` : err)) fails++;

host.stop?.();
console.log(fails ? `\n${fails} FAILURES` : '\nSHADER E2E OK');
process.exit(fails ? 1 : 0);
