// The multi-pass shader chain.
//
// A .glslp preset is N passes. Each renders into its own FBO, and that FBO
// becomes the next pass's input texture; the LAST pass renders to the screen.
// That chaining is the entire feature — 225 of 619 presets are multi-pass, up
// to 13 — and it is why this could not be built as "one shader" and extended
// later: the FBO sizing, per-axis scaling and alias binding ARE the
// architecture.
//
// Uses native-gles directly. retroemu already uses it for hw-rendered
// N64/PS1/Dreamcast cores, and a second GL binding in the same process would
// be asking for trouble (see internal-romdeck/SHADERS.md §9).
//
// SCOPE: no external LUT textures, no PassFeedback. Both are Phase 2 and both
// are reported by the parser rather than silently skipped.
import gl from 'native-gles';
import { readFileSync } from 'node:fs';
import { stagesFor, parseParameters } from './glsl-es.js';

// GL constants. native-gles exposes raw entry points, not the WebGL object
// API, so these are spelled out rather than read off a context.
const GL_VERTEX_SHADER = 0x8B31;
const GL_FRAGMENT_SHADER = 0x8B30;
const GL_COMPILE_STATUS = 0x8B81;
const GL_LINK_STATUS = 0x8B82;
const GL_ACTIVE_UNIFORMS = 0x8B86;
const GL_INT = 0x1404;
const GL_BOOL = 0x8B56;
const GL_ARRAY_BUFFER = 0x8892;
const GL_STATIC_DRAW = 0x88E4;
const GL_FLOAT = 0x1406;
const GL_TEXTURE_2D = 0x0DE1;
const GL_RGBA = 0x1908;
const GL_RGBA16F = 0x881A;
const GL_HALF_FLOAT = 0x140B;
const GL_UNSIGNED_BYTE = 0x1401;
const GL_TEXTURE0 = 0x84C0;
const GL_TEXTURE_MIN_FILTER = 0x2801;
const GL_TEXTURE_MAG_FILTER = 0x2800;
const GL_TEXTURE_WRAP_S = 0x2802;
const GL_TEXTURE_WRAP_T = 0x2803;
const GL_NEAREST = 0x2600;
const GL_LINEAR = 0x2601;
const GL_LINEAR_MIPMAP_LINEAR = 0x2703;
const GL_CLAMP_TO_EDGE = 0x812F;
const GL_REPEAT = 0x2901;
const GL_MIRRORED_REPEAT = 0x8370;
const GL_FRAMEBUFFER = 0x8D40;
const GL_COLOR_ATTACHMENT0 = 0x8CE0;
const GL_FRAMEBUFFER_COMPLETE = 0x8CD5;
const GL_COLOR_BUFFER_BIT = 0x4000;
const GL_TRIANGLE_STRIP = 0x0005;

const WRAP_GL = {
  clamp_to_edge: GL_CLAMP_TO_EDGE,
  edge: GL_CLAMP_TO_EDGE,
  // GLES 3.0 has no CLAMP_TO_BORDER; edge clamping is the closest legal
  // behaviour and is what most drivers fall back to anyway.
  clamp_to_border: GL_CLAMP_TO_EDGE,
  repeat: GL_REPEAT,
  mirrored_repeat: GL_MIRRORED_REPEAT,
};

function compileStage(type, src, label) {
  const s = gl.glCreateShader(type);
  gl.glShaderSource(s, src);
  gl.glCompileShader(s);
  if (!gl.glGetShaderiv(s, GL_COMPILE_STATUS)) {
    // native-gles returns the log from a single (shader) call, NUL-terminated.
    const log = String(gl.glGetShaderInfoLog(s) ?? '').replace(/\0/g, '').trim();
    gl.glDeleteShader(s);
    throw new Error(`${label}: ${log.split('\n')[0] || 'compile failed'}`);
  }
  return s;
}

/** One compiled pass, plus everything the runner needs to drive it. */
class Pass {
  constructor(spec, source) {
    this.spec = spec;
    this.params = parseParameters(source);

    const stages = stagesFor(source);
    const label = `pass ${spec.index} (${spec.rawPath})`;
    const v = compileStage(GL_VERTEX_SHADER, stages.vertex, `${label} vertex`);
    const f = compileStage(GL_FRAGMENT_SHADER, stages.fragment, `${label} fragment`);

    const prog = gl.glCreateProgram();
    gl.glAttachShader(prog, v);
    gl.glAttachShader(prog, f);
    gl.glLinkProgram(prog);
    if (!gl.glGetProgramiv(prog, GL_LINK_STATUS)) {
      const log = String(gl.glGetProgramInfoLog?.(prog) ?? '').replace(/\0/g, '').trim();
      throw new Error(`${label} link: ${log.split('\n')[0] || 'link failed'}`);
    }
    // Shaders are reference-counted by the program; drop our references.
    gl.glDeleteShader(v);
    gl.glDeleteShader(f);
    this.program = prog;

    // Reflect the uniforms the LINKED program actually has. This is why
    // parameter values are bound here rather than injected into the source:
    // the driver has already told us exactly which knobs survived, so a
    // preset override for a parameter the shader dropped is a no-op instead
    // of a compile error.
    this.uniforms = new Map();
    this.uniformTypes = new Map();
    const count = gl.glGetProgramiv(prog, GL_ACTIVE_UNIFORMS) || 0;
    for (let i = 0; i < count; i++) {
      const info = gl.glGetActiveUniform(prog, i);
      if (!info?.name) continue;
      const name = info.name.replace(/\[\d+\]$/, '');
      const loc = gl.glGetUniformLocation(prog, name);
      if (loc >= 0) {
        this.uniforms.set(name, loc);
        this.uniformTypes.set(name, info.type);
      }
    }

    // PassPrev*/PassFeedback* sample an EARLIER pass or the PREVIOUS frame.
    // Both are Phase 2 (they need per-pass history buffers). A shader that
    // wants one and does not get it samples an unbound texture and renders
    // BLACK — silently. Detect it here so the caller can refuse the preset
    // with a reason instead of showing the user a black screen.
    // Every spelling of "give me an earlier frame or pass":
    //   PrevTexture, Prev1Texture..Prev6Texture   previous FRAMES
    //   PassPrev1Texture..                        earlier PASSES
    //   PassFeedback*, OrigHistory*               ditto
    // Missing the bare `Prev*` form was not merely a black frame: sampling
    // seven unbound texture units SEGFAULTED the driver partway through a
    // corpus sweep (handheld/console-border/gba-2x.glslp).
    this.needsHistory = [...this.uniforms.keys()]
      .filter((n) => /^(Prev\d*Texture|PassPrev\d+|PassFeedback\d+|OrigHistory\d+)/.test(n));

    this.attribs = {
      vertex: gl.glGetAttribLocation(prog, 'VertexCoord'),
      texCoord: gl.glGetAttribLocation(prog, 'TexCoord'),
      color: gl.glGetAttribLocation(prog, 'COLOR'),
    };

    // Output target. Allocated lazily because its size depends on the frame.
    this.fbo = 0;
    this.tex = 0;
    this.outW = 0;
    this.outH = 0;
  }

  setUniform1f(name, v) {
    const l = this.uniforms.get(name);
    if (l !== undefined) gl.glUniform1f(l, v);
  }

  setUniform2f(name, a, b) {
    const l = this.uniforms.get(name);
    if (l !== undefined) gl.glUniform2f(l, a, b);
  }

  setUniform1i(name, v) {
    const l = this.uniforms.get(name);
    if (l !== undefined) gl.glUniform1i(l, v);
  }

  /** Bind a scalar using whichever of int/float the shader declared. */
  setUniformNumber(name, v) {
    const l = this.uniforms.get(name);
    if (l === undefined) return;
    const t = this.uniformTypes.get(name);
    if (t === GL_INT || t === GL_BOOL) gl.glUniform1i(l, Math.round(v));
    else gl.glUniform1f(l, v);
  }

  destroy() {
    if (this.fbo) gl.glDeleteFramebuffers(1, new Uint32Array([this.fbo]));
    if (this.tex) gl.glDeleteTextures(1, new Uint32Array([this.tex]));
    if (this.program) gl.glDeleteProgram?.(this.program);
    this.fbo = this.tex = this.program = 0;
  }
}

export class ShaderChain {
  /**
   * @param {{passes:Array, parameters:Object, unsupported:string[], warnings:string[]}} preset
   */
  constructor(preset) {
    this.preset = preset;
    this.passes = [];
    this.frameCount = 0;
    this.warnings = [...(preset.warnings ?? [])];
    this.unsupported = [...(preset.unsupported ?? [])];

    for (const spec of preset.passes) {
      const source = readFileSync(spec.path, 'utf8');
      this.passes.push(new Pass(spec, source));
    }
    if (!this.passes.length) throw new Error('preset has no passes');

    // Refuse loudly rather than render black. scalefx is the canonical case:
    // 5 passes that compile and link perfectly, then sample PassPrev2Texture
    // and produce a completely black frame.
    const history = this.passes.flatMap((p) => p.needsHistory.map((u) => `pass ${p.spec.index}: ${u}`));
    if (history.length) {
      for (const p of this.passes) p.destroy();
      throw new Error(`preset needs previous-pass/frame history, which is not implemented yet (${history.join(', ')})`);
    }

    // Aliases let a later pass sample an earlier one by name. Recorded now;
    // binding happens per draw.
    this.aliases = new Map();
    this.passes.forEach((p, i) => { if (p.spec.alias) this.aliases.set(p.spec.alias, i); });

    this._initGeometry();
  }

  _initGeometry() {
    // A full-screen quad, as FULL vec4s.
    //
    // The corpus declares `attribute vec4 VertexCoord` and `vec4 TexCoord` —
    // reflection confirms both link as vec4 (0x8B52). Supplying only 2 floats
    // leaves z=0,w=1 by GL default, and a shader that writes
    // `gl_Position = MVPMatrix * VertexCoord` then multiplies by a vector with
    // no w contribution from the buffer. Shaders that spell the multiply out
    // component-wise (crt-geom-mini) happened to survive; ones that use the
    // matrix form (dot, ntsc, mdapt, ...) rendered pure black. 19 presets.
    //
    // Layout per vertex: pos.xyzw, uv.xyzw  = 8 floats, 32 bytes.
    const buf = new Uint32Array(1);
    gl.glGenBuffers(1, buf);
    this.vbo = buf[0];
    gl.glBindBuffer(GL_ARRAY_BUFFER, this.vbo);
    gl.glBufferData(GL_ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, 1, 0, 1, 0, 1,
      1, -1, 0, 1, 1, 1, 0, 1,
      -1, 1, 0, 1, 0, 0, 0, 1,
      1, 1, 0, 1, 1, 0, 0, 1,
    ]), GL_STATIC_DRAW);

    // The source texture: the emulator frame, uploaded once per frame and
    // shared by every pass that wants `Original`.
    const t = new Uint32Array(1);
    gl.glGenTextures(1, t);
    this.sourceTex = t[0];
    this._srcW = 0;
    this._srcH = 0;
  }

  /** Resolve a pass's output size from its scale_type/scale and its input. */
  _sizeFor(spec, inW, inH, viewW, viewH) {
    const axis = (type, scale, inSize, viewSize) => {
      switch (type) {
        case 'viewport': return Math.max(1, Math.round(viewSize * scale));
        case 'absolute': return Math.max(1, Math.round(scale));
        case 'source':
        default: return Math.max(1, Math.round(inSize * scale));
      }
    };
    // A pass with no scale declared at all is 1:1 with its input.
    if (!spec.hasScale) return { w: inW, h: inH };
    return {
      w: axis(spec.scaleTypeX, spec.scaleX, inW, viewW),
      h: axis(spec.scaleTypeY, spec.scaleY, inH, viewH),
    };
  }

  /** Allocate or resize a pass's output FBO. */
  _ensureTarget(pass, w, h) {
    if (pass.fbo && pass.outW === w && pass.outH === h) return;
    if (pass.fbo) {
      gl.glDeleteFramebuffers(1, new Uint32Array([pass.fbo]));
      gl.glDeleteTextures(1, new Uint32Array([pass.tex]));
    }

    const t = new Uint32Array(1);
    gl.glGenTextures(1, t);
    pass.tex = t[0];
    gl.glBindTexture(GL_TEXTURE_2D, pass.tex);
    // float_framebuffer asks for more than 8 bits per channel. RGBA16F is the
    // GLES 3.0 spelling; presets that use it are doing multi-pass maths where
    // 8-bit rounding between passes is visible.
    if (pass.spec.floatFramebuffer) {
      gl.glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA16F, w, h, 0, GL_RGBA, GL_HALF_FLOAT, null);
    } else {
      gl.glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, null);
    }
    gl.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    gl.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    gl.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    gl.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);

    const fb = new Uint32Array(1);
    gl.glGenFramebuffers(1, fb);
    pass.fbo = fb[0];
    gl.glBindFramebuffer(GL_FRAMEBUFFER, pass.fbo);
    gl.glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, pass.tex, 0);
    const status = gl.glCheckFramebufferStatus(GL_FRAMEBUFFER);
    if (status !== GL_FRAMEBUFFER_COMPLETE) {
      // A float FBO can be unsupported on modest hardware. Say so rather than
      // rendering black: the caller can fall back to the CPU path.
      throw new Error(`pass ${pass.spec.index}: framebuffer incomplete (0x${status.toString(16)})`
        + (pass.spec.floatFramebuffer ? ' — float_framebuffer may be unsupported' : ''));
    }
    gl.glBindFramebuffer(GL_FRAMEBUFFER, 0);
    pass.outW = w;
    pass.outH = h;
  }

  _bindInput(pass, tex) {
    gl.glActiveTexture(GL_TEXTURE0);
    gl.glBindTexture(GL_TEXTURE_2D, tex);
    const f = pass.spec.filterLinear ? GL_LINEAR : GL_NEAREST;
    // mipmap_input needs a complete mip chain AND a mipmap min filter; asking
    // for one without the other samples black.
    if (pass.spec.mipmapInput) {
      gl.glGenerateMipmap?.(GL_TEXTURE_2D);
      gl.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR_MIPMAP_LINEAR);
    } else {
      gl.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, f);
    }
    gl.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, f);
    const wrap = WRAP_GL[pass.spec.wrapMode] ?? GL_CLAMP_TO_EDGE;
    gl.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, wrap);
    gl.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, wrap);
  }

  _drawQuad(pass, inW, inH, outW, outH, origW, origH) {
    gl.glUseProgram(pass.program);
    gl.glBindBuffer(GL_ARRAY_BUFFER, this.vbo);

    for (const [loc, offset] of [[pass.attribs.vertex, 0], [pass.attribs.texCoord, 16]]) {
      if (loc < 0) continue;
      gl.glEnableVertexAttribArray(loc);
      gl.glVertexAttribPointer(loc, 4, GL_FLOAT, false, 32, offset);
    }
    // COLOR is declared vec4 by most of the corpus and is usually multiplied
    // into the output. Unbound it defaults to (0,0,0,1) — transparent black —
    // which silently zeroes the whole frame. Bind it to white.
    if (pass.attribs.color >= 0) {
      gl.glDisableVertexAttribArray(pass.attribs.color);
      gl.glVertexAttrib4f?.(pass.attribs.color, 1, 1, 1, 1);
    }

    // The libretro uniform contract. TextureSize is the INPUT texture's real
    // dimensions; InputSize is the used region (identical here — cores hand us
    // an exactly-sized buffer); OutputSize is where we are drawing.
    pass.setUniform2f('TextureSize', inW, inH);
    pass.setUniform2f('InputSize', inW, inH);
    pass.setUniform2f('OutputSize', outW, outH);
    // The ORIGINAL emulator frame's size, distinct from this pass's input.
    // dot.glsl computes `TEX0.xy * TextureSize / InputSize * OrigInputSize`;
    // leaving OrigInputSize at its default zero multiplies every texture
    // coordinate by 0 and renders pure black. 22 shaders use it.
    pass.setUniform2f('OrigTextureSize', origW, origH);
    pass.setUniform2f('OrigInputSize', origW, origH);
    pass.setUniform2f('OriginalSize', origW, origH);
    pass.setUniform1i('Texture', 0);
    // `s_p` is the Cg-derived spelling of the input sampler (12 shaders,
    // including both crt-hyllian-multipass passes). Same texture unit.
    pass.setUniform1i('s_p', 0);

    // Extra samplers on their own texture units:
    //   OrigTexture   the ORIGINAL emulator frame, not this pass's input
    //   PassNTexture  the output of pass N (forward reference, unlike
    //                 PassPrev which counts backwards from the current pass)
    // Unbound, these sample texture unit 0 by default — i.e. silently the
    // wrong image — or nothing at all, which is how c64-monitor, nnedi3 and
    // artifact-colors rendered black.
    let unit = 1;
    const bindExtra = (name, tex, texW, texH) => {
      // Sizes are bound even when the SAMPLER itself was optimised out: a
      // shader may read Pass1TextureSize for geometry without ever sampling
      // Pass1Texture, and crt-hyllian-pass1 does exactly that.
      pass.setUniform2f(`${name}Size`, texW, texH);
      pass.setUniform2f(`${name.replace(/Texture$/, '')}InputSize`, texW, texH);
      if (!pass.uniforms.has(name) || !tex) return;
      gl.glActiveTexture(GL_TEXTURE0 + unit);
      gl.glBindTexture(GL_TEXTURE_2D, tex);
      gl.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
      gl.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
      gl.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
      gl.glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
      pass.setUniform1i(name, unit);
      unit++;
      gl.glActiveTexture(GL_TEXTURE0);
    };
    bindExtra('OrigTexture', this.sourceTex, origW, origH);
    for (let k = 0; k < this.passes.length; k++) {
      const earlier = this.passes[k];
      if (k >= pass.spec.index) break;      // only PRECEDING passes exist yet
      bindExtra(`Pass${k + 1}Texture`, earlier.tex, earlier.outW, earlier.outH);
      if (earlier.spec.alias) bindExtra(earlier.spec.alias, earlier.tex, earlier.outW, earlier.outH);
    }

    // frame_count_mod wraps the counter, for temporal effects like NTSC phase
    // alternation that only care about frame parity.
    const mod = pass.spec.frameCountMod;
    const fc = mod > 0 ? this.frameCount % mod : this.frameCount;
    // FrameCount is declared `int` by 1283 of the corpus's shaders and `float`
    // by the rest. Binding an int uniform with glUniform1f is silently ignored
    // by the driver, so the value stays 0 forever — misc/flicker multiplies
    // the frame by mod(FrameCount, 2.0) and rendered permanently black.
    // Bind by the REFLECTED type, not by assumption.
    pass.setUniformNumber('FrameCount', fc);
    pass.setUniformNumber('FrameDirection', 1);

    const mvp = pass.uniforms.get('MVPMatrix');
    if (mvp !== undefined) {
      gl.glUniformMatrix4fv(mvp, false, IDENTITY);
    }

    // Parameter values: preset overrides win, then the shader's own default.
    for (const p of pass.params) {
      const v = this.preset.parameters?.[p.name];
      pass.setUniform1f(p.name, v === undefined ? p.default : v);
    }

    gl.glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
  }

  /**
   * Run the whole chain for one frame.
   *
   * @param {Uint8Array} pixels RGBA source frame
   * @param {number} w
   * @param {number} h
   * @param {{x:number,y:number,w:number,h:number}} viewport where the final
   *        pass draws on the default framebuffer (already letterboxed)
   */
  render(pixels, w, h, viewport) {
    // Upload the emulator frame once. texSubImage2D on an unchanged size
    // avoids reallocating the texture every frame.
    gl.glActiveTexture(GL_TEXTURE0);
    gl.glBindTexture(GL_TEXTURE_2D, this.sourceTex);
    if (this._srcW !== w || this._srcH !== h) {
      gl.glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
      this._srcW = w;
      this._srcH = h;
    } else {
      gl.glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
    }

    let inTex = this.sourceTex;
    let inW = w;
    let inH = h;

    for (let i = 0; i < this.passes.length; i++) {
      const pass = this.passes[i];
      const isLast = i === this.passes.length - 1;

      let outW; let outH;
      if (isLast) {
        // The final pass renders to the screen: its size is the viewport, and
        // any scale it declares is ignored, exactly as RetroArch does.
        outW = viewport.w;
        outH = viewport.h;
        gl.glBindFramebuffer(GL_FRAMEBUFFER, 0);
        gl.glViewport(viewport.x, viewport.y, viewport.w, viewport.h);
      } else {
        const size = this._sizeFor(pass.spec, inW, inH, viewport.w, viewport.h);
        outW = size.w;
        outH = size.h;
        this._ensureTarget(pass, outW, outH);
        gl.glBindFramebuffer(GL_FRAMEBUFFER, pass.fbo);
        gl.glViewport(0, 0, outW, outH);
      }

      this._bindInput(pass, inTex);
      this._drawQuad(pass, inW, inH, outW, outH, w, h);

      inTex = isLast ? inTex : pass.tex;
      inW = outW;
      inH = outH;
    }

    gl.glBindFramebuffer(GL_FRAMEBUFFER, 0);
    this.frameCount++;
  }

  /** Every parameter across the chain, for a UI to render. */
  parameters() {
    const out = [];
    const seen = new Set();
    for (const p of this.passes) {
      for (const param of p.params) {
        if (seen.has(param.name)) continue;
        seen.add(param.name);
        const override = this.preset.parameters?.[param.name];
        out.push({ ...param, value: override === undefined ? param.default : override });
      }
    }
    return out;
  }

  setParameter(name, value) {
    this.preset.parameters = { ...(this.preset.parameters ?? {}), [name]: Number(value) };
  }

  destroy() {
    for (const p of this.passes) p.destroy();
    this.passes = [];
    if (this.vbo) gl.glDeleteBuffers?.(1, new Uint32Array([this.vbo]));
    if (this.sourceTex) gl.glDeleteTextures(1, new Uint32Array([this.sourceTex]));
    this.vbo = this.sourceTex = 0;
  }
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
