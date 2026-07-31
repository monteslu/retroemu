// GPU presentation, so a shader has somewhere to live.
//
// SDLRenderer presents with window.render() — a CPU blit. That stays, and
// stays the default: it works everywhere, needs no GL, and is what
// --video-filter (the CPU filter family) runs through.
//
// This is the other path. It uploads the frame as a texture and runs a
// .glslp preset chain over it, which is the only way to get RetroArch's
// actual shader corpus. Filters and shaders are different subsystems —
// see internal-romdeck/SHADERS.md §1 — and RetroArch does not combine them
// either, so --shader and --video-filter are mutually exclusive here too.
//
// THE CPU FRAME REMAINS AUTHORITATIVE. Screenshots, remote play and the
// overlay all read videoOutput.onFrameCallback, which fires on the RGBA
// buffer BEFORE presentation. This class consumes that buffer; it never
// replaces it. Proven by scripts/probe-gl-coexist.mjs.
import gl from 'native-gles';
import { loadPreset } from './shaders/preset.js';
import { ShaderChain } from './shaders/chain.js';

const GL_COLOR_BUFFER_BIT = 0x4000;

export class GLRenderer {
  constructor({ window, presetPath = null } = {}) {
    this.window = window;
    this.presetPath = presetPath;
    this.chain = null;
    this.warnings = [];
    this.frames = 0;
    this._contextOwned = false;
  }

  /**
   * Build a renderer, or return null if GL is unavailable.
   *
   * NEVER throws for a missing/broken GL stack: a machine without working GL
   * must fall back to the CPU blit, not fail to launch a game. A broken
   * PRESET is different — that is the user asking for something specific and
   * getting it wrong, so it is reported.
   */
  static async create({ window, presetPath, existingContext = false } = {}) {
    const r = new GLRenderer({ window, presetPath });
    try {
      if (!existingContext) {
        const w = window?.pixelWidth || 640;
        const h = window?.pixelHeight || 480;
        if (!gl.createContext(w, h)) return null;
        r._contextOwned = true;
      }
      gl.makeCurrent();
    } catch {
      return null;
    }

    if (presetPath) {
      // A preset that cannot be built is worth an error: the user named it.
      const preset = loadPreset(presetPath);
      r.chain = new ShaderChain(preset);
      r.warnings = [...(preset.warnings ?? []), ...(preset.unsupported ?? [])];
    }
    return r;
  }

  /** Swap the preset at runtime. Returns { ok } or { error }. */
  setPreset(presetPath) {
    try {
      const next = presetPath ? new ShaderChain(loadPreset(presetPath)) : null;
      this.chain?.destroy();
      this.chain = next;
      this.presetPath = presetPath;
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  }

  /**
   * Present one frame.
   *
   * @param {Uint8Array|Buffer} pixels RGBA8888
   */
  render(pixels, width, height) {
    if (!this.chain || !width || !height) return;
    gl.makeCurrent?.();

    // Aspect-correct letterbox in the VIEWPORT: the GPU scales, and the bars
    // cost nothing. The chain's final pass draws into this rect.
    const w = this.window?.pixelWidth || width;
    const h = this.window?.pixelHeight || height;
    const srcRatio = width / height;
    let dw; let dh;
    if (w / h > srcRatio) { dh = h; dw = Math.round(h * srcRatio); } else { dw = w; dh = Math.round(w / srcRatio); }
    const viewport = {
      x: Math.round((w - dw) / 2),
      y: Math.round((h - dh) / 2),
      w: dw,
      h: dh,
    };

    // Clear the whole target first so the letterbox bars are black rather
    // than whatever the last frame left there.
    gl.glViewport(0, 0, w, h);
    gl.glClearColor(0, 0, 0, 1);
    gl.glClear(GL_COLOR_BUFFER_BIT);

    this.chain.render(pixels, width, height, viewport);
    gl.swapBuffers?.();
    this.frames++;
  }

  filterFrame(pixels, width, height) {
    if (!this.chain || !width || !height) return { pixels, width, height };
    gl.makeCurrent?.();
    return {
      pixels: this.chain.renderToPixels(pixels, width, height),
      width,
      height,
    };
  }

  /** Shader parameters, for a UI to render and tweak. */
  parameters() {
    return this.chain?.parameters() ?? [];
  }

  setParameter(name, value) {
    this.chain?.setParameter(name, value);
  }

  status() {
    return {
      preset: this.presetPath,
      passes: this.chain?.passes.length ?? 0,
      frames: this.frames,
      warnings: this.warnings,
    };
  }

  destroy() {
    this.chain?.destroy();
    this.chain = null;
    if (this._contextOwned) {
      try { gl.destroyContext?.(); } catch { /* already gone */ }
      this._contextOwned = false;
    }
  }
}
