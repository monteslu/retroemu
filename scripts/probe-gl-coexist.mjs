// Probe 2: the constraint monteslu flagged.
//
// Screenshots, remote play and the overlay all tap videoOutput.onFrameCallback
// — the CPU-side RGBA buffer, BEFORE presentation. romdev's MCP screenshot
// tooling reads through that same path. So the question that decides the whole
// design is not "can GL present a frame" (probe 1 says yes) but:
//
//   does holding a native-gles context, and running a shader on every frame,
//   break the CPU RGBA callback that everything else depends on?
//
// Run a REAL game through the real VideoOutput, with a GL context live and a
// shader executing per frame, and assert the callback still delivers correct
// pixels.
import gl from 'native-gles';
import { readFileSync } from 'node:fs';
import { VideoOutput } from '../src/video/VideoOutput.js';

const CORPUS = '/tmp/claude-1000/-home-monteslu-code-cliemu/8d607e85-2b00-4f01-b123-94d31845fea9/scratchpad/glslsh';
const say = (q, ok, d = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${q}${d ? ' — ' + d : ''}`);

// ── a GL context + shader, exactly as a presenter would hold it ────
gl.createContext(320, 240);
gl.makeCurrent();

const GL_VERTEX_SHADER = 0x8B31, GL_FRAGMENT_SHADER = 0x8B30;
const GL_COMPILE_STATUS = 0x8B81, GL_LINK_STATUS = 0x8B82;
const GL_ARRAY_BUFFER = 0x8892, GL_STATIC_DRAW = 0x88E4, GL_FLOAT = 0x1406;
const GL_TEXTURE_2D = 0x0DE1, GL_RGBA = 0x1908, GL_UNSIGNED_BYTE = 0x1401;
const GL_TEXTURE0 = 0x84C0, GL_TEXTURE_MIN_FILTER = 0x2801, GL_TEXTURE_MAG_FILTER = 0x2800;
const GL_NEAREST = 0x2600, GL_CLAMP_TO_EDGE = 0x812F;
const GL_TEXTURE_WRAP_S = 0x2802, GL_TEXTURE_WRAP_T = 0x2803;
const GL_COLOR_BUFFER_BIT = 0x4000, GL_TRIANGLE_STRIP = 0x0005;

const body = readFileSync(`${CORPUS}/crt/shaders/crt-geom-mini.glsl`, 'utf8').replace(/^\s*#version.*$/gm, '');
const head = (st) => `#version 300 es\nprecision highp float;\nprecision highp int;\n#define ${st} 1\n`;
const mk = (type, src) => {
  const s = gl.glCreateShader(type);
  gl.glShaderSource(s, src);
  gl.glCompileShader(s);
  if (!gl.glGetShaderiv(s, GL_COMPILE_STATUS)) {
    throw new Error(String(gl.glGetShaderInfoLog(s)).replace(/\0/g, '').split('\n')[0]);
  }
  return s;
};
const prog = gl.glCreateProgram();
gl.glAttachShader(prog, mk(GL_VERTEX_SHADER, head('VERTEX') + body));
gl.glAttachShader(prog, mk(GL_FRAGMENT_SHADER, head('FRAGMENT') + body));
gl.glLinkProgram(prog);
if (!gl.glGetProgramiv(prog, GL_LINK_STATUS)) throw new Error('link failed');
gl.glUseProgram(prog);

const texs = new Uint32Array(1); gl.glGenTextures(1, texs);
gl.glActiveTexture(GL_TEXTURE0);
gl.glBindTexture(GL_TEXTURE_2D, texs[0]);
gl.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
gl.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
gl.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
gl.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
const bufs = new Uint32Array(1); gl.glGenBuffers(1, bufs);
gl.glBindBuffer(GL_ARRAY_BUFFER, bufs[0]);
gl.glBufferData(GL_ARRAY_BUFFER, new Float32Array([-1,-1,0,1, 1,-1,1,1, -1,1,0,0, 1,1,1,0]), GL_STATIC_DRAW);
for (const [n, off] of [['VertexCoord', 0], ['TexCoord', 8]]) {
  const l = gl.glGetAttribLocation(prog, n);
  if (l >= 0) { gl.glEnableVertexAttribArray(l); gl.glVertexAttribPointer(l, 2, GL_FLOAT, false, 16, off); }
}
let texW = 0, texH = 0, shaderFrames = 0;
function shadeFrame(px, w, h) {
  gl.glBindTexture(GL_TEXTURE_2D, texs[0]);
  if (texW !== w || texH !== h) {
    gl.glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, px);
    texW = w; texH = h;
  } else {
    gl.glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, px);
  }
  const u2 = (n, a, b) => { const l = gl.glGetUniformLocation(prog, n); if (l >= 0) gl.glUniform2f(l, a, b); };
  u2('TextureSize', w, h); u2('InputSize', w, h); u2('OutputSize', w, h);
  const tl = gl.glGetUniformLocation(prog, 'Texture'); if (tl >= 0) gl.glUniform1i(tl, 0);
  const m = gl.glGetUniformLocation(prog, 'MVPMatrix');
  if (m >= 0) gl.glUniformMatrix4fv(m, false, new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]));
  gl.glViewport(0, 0, w, h);
  gl.glClearColor(0, 0, 0, 1);
  gl.glClear(GL_COLOR_BUFFER_BIT);
  gl.glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
  shaderFrames++;
}

// ── a real game through the real VideoOutput ───────────────────────
const { LibretroHost } = await import('../src/core/LibretroHost.js');
const { loadRom } = await import('../src/core/RomLoader.js');
const { detectSystem } = await import('../src/core/SystemDetector.js');

const ROM = '/home/monteslu/code/cliemu/roms-real/gb/Tetris (World) (Rev 1).gb';
const info = await loadRom(ROM);
const system = detectSystem(info.romPath);

// video: 'none' — we are testing the CALLBACK, not SDL presentation.
const videoOutput = new VideoOutput({ video: 'none' });

const seen = [];
let lastFrame = null;
videoOutput.onFrameCallback = (rgba, w, h) => {
  seen.push({ w, h, len: rgba.length, nonBlack: countLit(rgba) });
  lastFrame = { rgba: Uint8Array.from(rgba), w, h };
  shadeFrame(rgba, w, h);          // shader runs on EVERY frame, as it would
};
function countLit(px) {
  let n = 0;
  for (let i = 0; i < px.length; i += 4 * 37) if (px[i] || px[i + 1] || px[i + 2]) n++;
  return n;
}

// Minimal audio stub: the host inits and pushes to it unconditionally, and we
// are testing video, not sound.
const audioBridge = { init: async () => {}, onAudioBatch: () => 0, onAudioSample: () => {}, push: () => {}, write: () => {}, stop: () => {}, close: () => {} };
const host = new LibretroHost({ videoOutput, audioBridge, inputManager: { poll: () => {}, getState: () => 0, isPressed: () => false, getAnalog: () => 0 }, saveManager: { loadSRAM: async () => {}, saveSRAM: async () => {}, load: () => null, save: () => {} } });
await host.loadAndStart(info.romPath, { saveDir: '/tmp', romData: info.data });
await new Promise((r) => setTimeout(r, 3000));

say('Q5 RGBA callback still fires with a GL context live', seen.length > 30, `${seen.length} frames`);
const good = seen.filter((f) => f.len === f.w * f.h * 4);
say('Q5b callback buffers are correctly sized', good.length === seen.length,
  `${good.length}/${seen.length} at w*h*4`);
const lit = seen.filter((f) => f.nonBlack > 0);
say('Q5c callback pixels are real (not blanked by GL)', lit.length > seen.length * 0.5,
  `${lit.length}/${seen.length} frames had lit pixels`);
say('Q5d shader ran on every delivered frame', shaderFrames === seen.length,
  `${shaderFrames} shader passes / ${seen.length} callbacks`);

// And the shaded result is still readable — i.e. GL did not silently die
// partway through a real session.
const out = new Uint8Array(texW * texH * 4);
gl.glFinish();
gl.glReadPixels(0, 0, texW, texH, GL_RGBA, GL_UNSIGNED_BYTE, out);
const cols = new Set();
for (let i = 0; i < out.length; i += 4) cols.add((out[i] << 16) | (out[i + 1] << 8) | out[i + 2]);
say('Q5e GL still renders after a live session', cols.size > 4, `${cols.size} distinct colours`);

// Q6: the thing that actually matters downstream — a screenshot taken the way
// ControlChannel takes one (last callback frame -> PNG) must still be valid.
const { rgbaToPng } = await import('../src/control/png.js');
const last = lastFrame;
let png = null, err = '';
try { png = rgbaToPng(last.rgba, last.w, last.h); } catch (e) { err = e.message; }
const isPng = !!png && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
say('Q6 screenshot PNG still encodes from the callback frame', isPng,
  isPng ? `${png.length} bytes, ${last.w}x${last.h}` : err || 'not a PNG');

host.stop?.();
gl.destroyContext?.();
console.log('\nprobe 2 done');
process.exit(0);
