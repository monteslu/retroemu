// RetroArch .glslp preset parsing. These files come from a large third-party
// corpus, so the parser's job is as much about failing usefully on the odd ones
// as about reading the normal ones — a bad preset must name what is wrong
// rather than surface later as "no shader passes" or a blank screen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parsePreset } from '../../src/video/shaders/preset.js';
import { GLRenderer } from '../../src/video/GLRenderer.js';

test('parses a minimal single-pass preset', () => {
  const p = parsePreset('shaders = 1\nshader0 = crt.glsl\n', '/presets');
  assert.equal(p.passes.length, 1);
  assert.equal(p.passes[0].rawPath, 'crt.glsl');
  assert.equal(p.passes[0].path, path.resolve('/presets', 'crt.glsl'),
    'shader path resolves against the preset directory, not the cwd');
});

test('ignores comments and blank lines', () => {
  const p = parsePreset(`
# a comment
// another comment

shaders = 1
shader0 = a.glsl
`, '.');
  assert.equal(p.passes.length, 1);
});

test('per-axis scale_type overrides the combined form', () => {
  // A real 13-pass NTSC preset mixes source-x with absolute-y; the more
  // specific per-axis key has to win.
  const p = parsePreset([
    'shaders = 1',
    'shader0 = a.glsl',
    'scale_type0 = source',
    'scale_type_y0 = absolute',
  ].join('\n'), '.');
  assert.equal(p.passes[0].scaleTypeX, 'source', 'x falls back to the combined key');
  assert.equal(p.passes[0].scaleTypeY, 'absolute', 'y takes the specific key');
});

test('unknown scale_type and wrap_mode warn instead of throwing', () => {
  // A weird value in one pass must not sink an otherwise usable preset.
  const p = parsePreset([
    'shaders = 1',
    'shader0 = a.glsl',
    'scale_type0 = banana',
    'wrap_mode0 = sideways',
  ].join('\n'), '.');
  assert.equal(p.passes.length, 1, 'preset still parses');
  assert.equal(p.passes[0].scaleTypeX, 'source', 'falls back to source');
  assert.equal(p.passes[0].wrapMode, 'clamp_to_edge', 'falls back to clamp');
  assert.ok(p.warnings.length >= 2, 'both oddities are reported');
  assert.ok(p.warnings.some(w => /banana/.test(w)), 'warning names the bad value');
});

test('a missing shader count is a NAMED error', () => {
  assert.throws(
    () => parsePreset('filter_linear0 = true\n', '.'),
    /no shader passes|missing .shaders./,
  );
});

test('a malformed shader count is distinguished from a missing one', () => {
  assert.throws(
    () => parsePreset('shaders = lots\nshader0 = a.glsl\n', '.'),
    /malformed shader count/,
  );
});

test('a declared pass with no shaderN names the missing index', () => {
  assert.throws(
    () => parsePreset('shaders = 2\nshader0 = a.glsl\n', '.'),
    /no shader1/,
    'the error should say WHICH pass is missing',
  );
});

test('an absurd pass count is rejected before allocating FBOs', () => {
  assert.throws(
    () => parsePreset('shaders = 9999\nshader0 = a.glsl\n', '.'),
    /max 32/,
  );
});

test('#reference inheritance is refused by name, not ignored', () => {
  // Unsupported on purpose. Silently ignoring it would parse the file as
  // "no passes" and report a misleading error.
  assert.throws(
    () => parsePreset('#reference "other.glslp"\nshaders = 1\nshader0 = a.glsl\n', '.'),
    /#reference|inheritance/,
  );
});

test('a preset can render offscreen for game-scoped Active Bezel effects', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'retroemu-shader-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shader = path.join(dir, 'invert.glsl');
  const preset = path.join(dir, 'invert.glslp');
  writeFileSync(preset, 'shaders = 1\nshader0 = invert.glsl\nfilter_linear0 = false\n');
  writeFileSync(shader, `
#if defined(VERTEX)
in vec4 VertexCoord;
in vec4 TexCoord;
out vec2 texCoord;
void main() {
  gl_Position = VertexCoord;
  texCoord = TexCoord.xy;
}
#elif defined(FRAGMENT)
uniform sampler2D Texture;
in vec2 texCoord;
out vec4 FragColor;
void main() {
  vec4 c = texture(Texture, texCoord);
  FragColor = vec4(1.0 - c.rgb, c.a);
}
#endif
`);

  const renderer = await GLRenderer.create({ presetPath: preset });
  if (!renderer) {
    t.skip('OpenGL ES context is unavailable on this machine');
    return;
  }
  t.after(() => renderer.destroy());

  const source = new Uint8Array([
    10, 20, 30, 255, 40, 50, 60, 255,
    70, 80, 90, 255, 100, 110, 120, 255,
  ]);
  const result = renderer.filterFrame(source, 2, 2);
  assert.equal(result.width, 2);
  assert.equal(result.height, 2);
  assert.deepEqual([...result.pixels], [
    245, 235, 225, 255, 215, 205, 195, 255,
    185, 175, 165, 255, 155, 145, 135, 255,
  ]);
});
