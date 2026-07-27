// Does the FBO chain actually run real presets?
//
// Single-pass is the easy case. The ones that matter are multi-pass presets
// with per-axis scaling and float framebuffers, because the FBO sizing and
// pass-to-pass binding ARE the architecture.
import gl from 'native-gles';
import path from 'node:path';
import { loadPreset } from '../src/video/shaders/preset.js';
import { ShaderChain } from '../src/video/shaders/chain.js';

const CORPUS = process.argv[2]
  ?? '/tmp/claude-1000/-home-monteslu-code-cliemu/8d607e85-2b00-4f01-b123-94d31845fea9/scratchpad/glslsh';
const W = 256; const H = 224;
const OUT_W = 640; const OUT_H = 480;
const GL_RGBA = 0x1908, GL_UNSIGNED_BYTE = 0x1401;

const say = (q, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${q}${d ? ' — ' + d : ''}`); return ok; };

gl.createContext(OUT_W, OUT_H);
gl.makeCurrent();

// A recognisable source frame: 8 vertical colour bars.
const frame = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const bar = Math.floor(x / (W / 8));
    frame[i] = (bar & 1) ? 255 : 0;
    frame[i + 1] = (bar & 2) ? 255 : 0;
    frame[i + 2] = (bar & 4) ? 255 : 0;
    frame[i + 3] = 255;
  }
}

function readback() {
  const out = new Uint8Array(OUT_W * OUT_H * 4);
  gl.glFinish();
  gl.glReadPixels(0, 0, OUT_W, OUT_H, GL_RGBA, GL_UNSIGNED_BYTE, out);
  let lit = 0; const colours = new Set();
  for (let i = 0; i < out.length; i += 4) {
    if (out[i] || out[i + 1] || out[i + 2]) lit++;
    colours.add((out[i] << 16) | (out[i + 1] << 8) | out[i + 2]);
  }
  return { lit, colours: colours.size, out };
}

const viewport = { x: 0, y: 0, w: OUT_W, h: OUT_H };
let failures = 0;

// ── a real single-pass CRT preset ──────────────────────────────────
{
  const p = loadPreset(path.join(CORPUS, 'crt/crt-geom-mini.glslp'));
  const chain = new ShaderChain(p);
  chain.render(frame, W, H, viewport);
  const r = readback();
  if (!say('single-pass crt-geom-mini renders', r.lit > OUT_W * OUT_H * 0.2 && r.colours > 8,
    `${r.lit} lit, ${r.colours} colours, ${chain.passes.length} pass`)) failures++;
  chain.destroy();
}

// ── multi-pass, the case this exists for ───────────────────────────
{
  const p = loadPreset(path.join(CORPUS, 'xsoft/4xsoftSdB.glslp'));
  const chain = new ShaderChain(p);
  if (!say('multi-pass preset compiles', chain.passes.length === 3,
    `${chain.passes.length} passes`)) failures++;
  chain.render(frame, W, H, viewport);
  const r = readback();
  if (!say('multi-pass 4xsoftSdB renders', r.lit > OUT_W * OUT_H * 0.2 && r.colours > 8,
    `${r.lit} lit, ${r.colours} colours`)) failures++;

  // Intermediate FBOs must be sized by scale_type/scale, not by the viewport.
  // 4xsoftSdB scales source x2 twice, so 256x224 -> 512x448 -> 1024x896.
  const sizes = chain.passes.slice(0, -1).map((x) => `${x.outW}x${x.outH}`);
  if (!say('intermediate FBOs scaled per scale_type', sizes[0] === '512x448',
    sizes.join(' -> '))) failures++;
  chain.destroy();
}

// ── a deeper in-scope preset ───────────────────────────────────────
{
  const p = loadPreset(path.join(CORPUS, 'xbr/xbr-hybrid.glslp'));
  const chain = new ShaderChain(p);
  if (!say('deeper preset compiles', chain.passes.length >= 3,
    `${chain.passes.length} passes`)) failures++;
  chain.render(frame, W, H, viewport);
  const r = readback();
  if (!say('deeper preset renders', r.lit > OUT_W * OUT_H * 0.2 && r.colours > 4,
    `${r.lit} lit, ${r.colours} colours`)) failures++;
  chain.destroy();
}

// ── deferred features must REFUSE, not render black ────────────────
// scalefx compiles and links perfectly, then samples PassPrev2Texture and
// produces a black frame. Silently showing black is the worst outcome.
{
  let refused = false; let why = '';
  try {
    const p = loadPreset(path.join(CORPUS, 'scalefx/scalefx.glslp'));
    new ShaderChain(p);
  } catch (err) { refused = true; why = err.message.slice(0, 80); }
  if (!say('preset needing PassPrev is refused with a reason', refused, why)) failures++;
}

// ── the chain must CHANGE the frame ────────────────────────────────
// A pass-through also looks "lit". Compare a shader chain's output against a
// plain blit of the same source.
{
  const stock = loadPreset(path.join(CORPUS, 'crt/crt-geom-mini.glslp'));
  const a = new ShaderChain(stock);
  a.render(frame, W, H, viewport);
  const shaded = readback().out;
  a.destroy();

  // Nearest-neighbour upscale of the source, for comparison.
  let differs = 0;
  for (let y = 0; y < OUT_H; y += 4) {
    for (let x = 0; x < OUT_W; x += 4) {
      const si = ((Math.floor(y * H / OUT_H)) * W + Math.floor(x * W / OUT_W)) * 4;
      const di = (y * OUT_W + x) * 4;
      if (Math.abs(shaded[di] - frame[si]) > 8
        || Math.abs(shaded[di + 1] - frame[si + 1]) > 8
        || Math.abs(shaded[di + 2] - frame[si + 2]) > 8) differs++;
    }
  }
  const total = (OUT_H / 4) * (OUT_W / 4);
  if (!say('chain output differs from a plain blit', differs > total * 0.05,
    `${((differs / total) * 100).toFixed(1)}% of sampled pixels changed`)) failures++;
}

// ── parameters are discoverable and settable ───────────────────────
{
  const p = loadPreset(path.join(CORPUS, 'crt/crt-geom-mini.glslp'));
  const chain = new ShaderChain(p);
  const params = chain.parameters();
  if (!say('parameters exposed for a UI', params.length > 0,
    `${params.length}: ${params.slice(0, 3).map((x) => x.name).join(', ')}`)) failures++;
  if (params.length) {
    const first = params[0];
    chain.setParameter(first.name, first.max);
    const after = chain.parameters().find((x) => x.name === first.name);
    if (!say('setParameter takes effect', after.value === first.max,
      `${first.name} = ${after.value}`)) failures++;
    chain.render(frame, W, H, viewport);
    const r = readback();
    if (!say('renders with an overridden parameter', r.colours > 4,
      `${r.colours} colours`)) failures++;
  }
  chain.destroy();
}

// ── resilience: many frames, and a geometry change mid-stream ──────
// The second frame size must use a REAL PATTERN, not a flat fill: a flat
// source legitimately shades to one colour, which looks exactly like the
// chain having died. That cost a debugging round.
{
  const bars = (w, h) => {
    const f = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const b = Math.floor(x / (w / 8));
        f[i] = (b & 1) ? 255 : 0;
        f[i + 1] = (b & 2) ? 255 : 0;
        f[i + 2] = (b & 4) ? 255 : 0;
        f[i + 3] = 255;
      }
    }
    return f;
  };
  const p = loadPreset(path.join(CORPUS, 'xsoft/4xsoftSdB.glslp'));
  const chain = new ShaderChain(p);
  for (let i = 0; i < 120; i++) chain.render(frame, W, H, viewport);
  const before = readback();
  const small = bars(160, 144);
  for (let i = 0; i < 30; i++) chain.render(small, 160, 144, viewport);
  const r = readback();
  if (!say('survives 150 frames incl. a resolution change', r.colours > 4 && before.colours > 4,
    `${before.colours} -> ${r.colours} colours, frameCount=${chain.frameCount}`)) failures++;
  // The intermediate FBOs must have been REBUILT for the new source size.
  const sizes = chain.passes.slice(0, -1).map((x) => `${x.outW}x${x.outH}`);
  if (!say('FBOs resized for the new geometry', sizes[0] === '320x288',
    sizes.join(' -> '))) failures++;
  chain.destroy();
}

// ── regressions for two silent-black bugs ──────────────────────────
// Both rendered a perfectly black frame with no GL error and no failed
// assertion anywhere else.
{
  // 1. FrameCount is declared `int` by 1283 corpus shaders. Binding an int
  //    uniform with glUniform1f is silently ignored, so it stayed 0 forever
  //    and misc/flicker (frame * mod(FrameCount, 2.0)) was always black.
  const detail = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      detail[i] = (x * 7 + y * 3) & 255;
      detail[i + 1] = ((x * x / 64) + y) & 255;
      detail[i + 2] = ((x ^ y) * 3) & 255;
      detail[i + 3] = 255;
    }
  }
  const chain = new ShaderChain(loadPreset(path.join(CORPUS, 'misc/flicker.glslp')));
  chain.render(detail, W, H, viewport);
  const f0 = readback();
  chain.render(detail, W, H, viewport);
  const f1 = readback();
  // Frame 0 IS legitimately black here (mod(0,2) == 0); frame 1 must not be.
  if (!say('int-typed FrameCount reaches the shader', f1.colours > 100,
    `frame0 ${f0.colours} colours -> frame1 ${f1.colours}`)) failures++;
  chain.destroy();
}
{
  // 2. OrigInputSize was never bound, so handheld/dot.glsl multiplied every
  //    texture coordinate by zero. 22 shaders read it.
  const chain = new ShaderChain(loadPreset(path.join(CORPUS, 'handheld/dot.glslp')));
  chain.render(frame, W, H, viewport);
  const r = readback();
  if (!say('OrigInputSize is bound', r.colours > 8, `${r.colours} colours`)) failures++;
  chain.destroy();
}

console.log(`\n${failures ? `${failures} FAILURES` : 'CHAIN OK'}`);
process.exit(failures ? 1 : 0);
