// Probe: can a native-gles context host a shader pass for 2D presentation,
// alongside everything retroemu already does?
//
// Four questions, in order of how badly a "no" would hurt:
//   Q1 does a native-gles context come up at all here?
//   Q2 can a real RetroArch .glsl shader compile through it? (native-gles is
//      raw GLES, NOT webgl-node — different binding, different dialect rules)
//   Q3 can we upload an RGBA frame, run the shader, and read real pixels back?
//   Q4 does this coexist with LibretroGL's own context, or fight it?
import gl from 'native-gles';
import { readFileSync } from 'node:fs';

const CORPUS = '/tmp/claude-1000/-home-monteslu-code-cliemu/8d607e85-2b00-4f01-b123-94d31845fea9/scratchpad/glslsh';
const W = 256; const H = 224;

const say = (q, ok, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${q}${detail ? ' — ' + detail : ''}`);

// ── Q1: context ────────────────────────────────────────────────────
const made = gl.createContext(W, H);
say('Q1 native-gles context created', !!made);
if (!made) process.exit(1);
gl.makeCurrent();
const info = gl.getContextInfo?.() ?? {};
console.log('      info:', JSON.stringify(info).slice(0, 160));

// native-gles exposes raw gl* calls, not the WebGL object API. Check what we
// actually have to work with before assuming a shader pipeline is possible.
const need = ['glCreateShader', 'glShaderSource', 'glCompileShader', 'glCreateProgram',
  'glAttachShader', 'glLinkProgram', 'glUseProgram', 'glGenTextures', 'glBindTexture',
  'glTexImage2D', 'glTexSubImage2D', 'glDrawArrays', 'glReadPixels', 'glGenBuffers',
  'glBufferData', 'glVertexAttribPointer', 'glEnableVertexAttribArray',
  'glGetUniformLocation', 'glUniform1i', 'glUniform2f', 'glGetShaderiv',
  'glGetShaderInfoLog', 'glGetProgramiv', 'glViewport', 'glClear', 'glClearColor',
  'glActiveTexture', 'glTexParameteri', 'glGetAttribLocation'];
const missing = need.filter((n) => typeof gl[n] !== 'function');
say('Q1b required GL entry points present', missing.length === 0,
  missing.length ? `missing: ${missing.slice(0, 6).join(', ')}` : `${need.length} checked`);
if (missing.length) process.exit(1);

// ── Q2: compile a real RetroArch shader ────────────────────────────
const GL_VERTEX_SHADER = 0x8B31, GL_FRAGMENT_SHADER = 0x8B30;
const GL_COMPILE_STATUS = 0x8B81, GL_LINK_STATUS = 0x8B82;

function compile(type, src) {
  const s = gl.glCreateShader(type);
  gl.glShaderSource(s, src);
  gl.glCompileShader(s);
  // native-gles RETURNS the value — it does not fill an out-array. Passing a
  // typed array leaves it zeroed, which reads as "compile failed" with an
  // empty info log: a probe bug that looks exactly like a broken GL stack.
  const ok = gl.glGetShaderiv(s, GL_COMPILE_STATUS);
  if (!ok) {
    // native-gles returns the log as a NUL-terminated string from a single
    // (shader) call — not the (shader, maxLen, lenOut, buf) C shape.
    const raw = String(gl.glGetShaderInfoLog(s) ?? '').replace(/\0/g, '').trim();
    return { ok: false, log: raw.split('\n')[0] || '(empty log)', s };
  }
  return { ok: true, s };
}

const { stagesFor } = await import('../src/video/shaders/glsl-es.js');
const SHADER = `${CORPUS}/crt/shaders/crt-geom-mini.glsl`;
const st0 = stagesFor(readFileSync(SHADER, 'utf8'));

const v = compile(GL_VERTEX_SHADER, st0.vertex);
const f = compile(GL_FRAGMENT_SHADER, st0.fragment);
say('Q2 real RetroArch shader compiles (crt-geom-mini)', v.ok && f.ok,
  v.ok && f.ok ? 'both stages' : `${v.ok ? '' : 'V:' + v.log} ${f.ok ? '' : 'F:' + f.log}`);
if (!v.ok || !f.ok) process.exit(1);

const prog = gl.glCreateProgram();
gl.glAttachShader(prog, v.s);
gl.glAttachShader(prog, f.s);
gl.glLinkProgram(prog);
const linked = gl.glGetProgramiv(prog, GL_LINK_STATUS);
say('Q2b program links', !!linked,
  linked ? '' : String(gl.glGetProgramInfoLog?.(prog) ?? '').replace(/\0/g, '').split('\n')[0]);
if (!linked) process.exit(1);

// ── Q3: upload a frame, run the shader, read pixels back ───────────
const GL_ARRAY_BUFFER = 0x8892, GL_STATIC_DRAW = 0x88E4, GL_FLOAT = 0x1406;
const GL_TEXTURE_2D = 0x0DE1, GL_RGBA = 0x1908, GL_UNSIGNED_BYTE = 0x1401;
const GL_TEXTURE0 = 0x84C0, GL_TEXTURE_MIN_FILTER = 0x2801, GL_TEXTURE_MAG_FILTER = 0x2800;
const GL_NEAREST = 0x2600, GL_CLAMP_TO_EDGE = 0x812F;
const GL_TEXTURE_WRAP_S = 0x2802, GL_TEXTURE_WRAP_T = 0x2803;
const GL_COLOR_BUFFER_BIT = 0x4000, GL_TRIANGLE_STRIP = 0x0005;

gl.glUseProgram(prog);

// A recognisable test "frame": vertical colour bars, like a game would give us.
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

const texs = new Uint32Array(1);
gl.glGenTextures(1, texs);
gl.glActiveTexture(GL_TEXTURE0);
gl.glBindTexture(GL_TEXTURE_2D, texs[0]);
gl.glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, W, H, 0, GL_RGBA, GL_UNSIGNED_BYTE, frame);
gl.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
gl.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
gl.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
gl.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);

const bufs = new Uint32Array(1);
gl.glGenBuffers(1, bufs);
gl.glBindBuffer(GL_ARRAY_BUFFER, bufs[0]);
gl.glBufferData(GL_ARRAY_BUFFER, new Float32Array([
  -1, -1, 0, 1, 1, -1, 1, 1, -1, 1, 0, 0, 1, 1, 1, 0,
]), GL_STATIC_DRAW);

for (const [name, off] of [['VertexCoord', 0], ['TexCoord', 8]]) {
  const loc = gl.glGetAttribLocation(prog, name);
  if (loc < 0) continue;
  gl.glEnableVertexAttribArray(loc);
  gl.glVertexAttribPointer(loc, 2, GL_FLOAT, false, 16, off);
}

const u2 = (n, a, b) => { const l = gl.glGetUniformLocation(prog, n); if (l >= 0) gl.glUniform2f(l, a, b); };
u2('TextureSize', W, H); u2('InputSize', W, H); u2('OutputSize', W, H);
const tl = gl.glGetUniformLocation(prog, 'Texture');
if (tl >= 0) gl.glUniform1i(tl, 0);
const mvp = gl.glGetUniformLocation(prog, 'MVPMatrix');
if (mvp >= 0 && gl.glUniformMatrix4fv) {
  // (location, transpose, data) — no count argument in this binding.
  gl.glUniformMatrix4fv(mvp, false, new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]));
}

gl.glViewport(0, 0, W, H);
gl.glClearColor(0, 0, 0, 1);
gl.glClear(GL_COLOR_BUFFER_BIT);
gl.glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
gl.glFinish();

const out = new Uint8Array(W * H * 4);
gl.glReadPixels(0, 0, W, H, GL_RGBA, GL_UNSIGNED_BYTE, out);

let nonBlack = 0; const colours = new Set();
for (let i = 0; i < out.length; i += 4) {
  if (out[i] || out[i + 1] || out[i + 2]) nonBlack++;
  colours.add((out[i] << 16) | (out[i + 1] << 8) | out[i + 2]);
}
say('Q3 shader renders real pixels', nonBlack > W * H * 0.25 && colours.size > 8,
  `${nonBlack}/${W * H} lit, ${colours.size} colours`);

// The shader must CHANGE the frame — a pass-through would also be "lit".
let differs = 0;
for (let i = 0; i < out.length; i += 4) {
  if (out[i] !== frame[i] || out[i + 1] !== frame[i + 1] || out[i + 2] !== frame[i + 2]) differs++;
}
say('Q3b output differs from input (shader actually ran)', differs > W * H * 0.05,
  `${((differs / (W * H)) * 100).toFixed(1)}% of pixels changed`);

// ── Q4: does LibretroGL still work alongside this? ─────────────────
// Its createContext(contextExists=true) path resizes and makes current, which
// is what a 3D core would do after we already hold a context.
let coexist = true; let why = '';
try {
  gl.resizeContext(320, 240);
  gl.makeCurrent();
  gl.glViewport(0, 0, 320, 240);
  const probe = new Uint8Array(4);
  gl.glClearColor(0, 0, 1, 1);
  gl.glClear(GL_COLOR_BUFFER_BIT);
  gl.glFinish();
  gl.glReadPixels(0, 0, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, probe);
  coexist = probe[2] > 200;
  why = `after resize+makeCurrent, cleared pixel = ${[...probe].join(',')}`;
} catch (err) {
  coexist = false; why = err.message;
}
say('Q4 context survives LibretroGL-style resize/makeCurrent', coexist, why);

gl.destroyContext?.();
console.log('\nprobe done');
process.exit(0);
