// CRT-style video filters, applied to the RGBA framebuffer before it reaches
// the SDL texture.
//
// These are CPU post-processes, not libretro GLSL shader presets — the SDL
// path is software-rendered, and at 240p-class resolutions a 2x scanline +
// aperture-mask pass costs well under a millisecond, which is the honest
// trade for not requiring a GL context. (The .glslp preset pipeline stays on
// the roadmap for the GL path.)
//
//   none       pass through
//   scanlines  2x vertical scale, every other line darkened
//   crt        scanlines + RGB aperture mask + slight glow
//   sharp      2x nearest scale only (crisp pixels, no effect)

const FILTERS = new Set(['none', 'scanlines', 'crt', 'sharp']);

export function isFilter(name) {
  return FILTERS.has(name);
}

export function filterNames() {
  return [...FILTERS];
}

/**
 * @param {Uint8Array} src RGBA pixels
 * @param {number} w
 * @param {number} h
 * @param {string} filter
 * @param {Uint8Array|null} out reusable destination (2x size) to avoid churn
 * @returns {{pixels:Uint8Array, width:number, height:number}}
 */
export function applyFilter(src, w, h, filter, out = null) {
  if (filter === 'none' || !FILTERS.has(filter)) {
    return { pixels: src, width: w, height: h };
  }

  const dw = w * 2;
  const dh = h * 2;
  const need = dw * dh * 4;
  const dst = out && out.length === need ? out : new Uint8Array(need);

  const scanline = filter === 'scanlines' || filter === 'crt';
  const mask = filter === 'crt';

  for (let y = 0; y < h; y++) {
    const srow = y * w * 4;
    for (let x = 0; x < w; x++) {
      const s = srow + x * 4;
      let r = src[s];
      let g = src[s + 1];
      let b = src[s + 2];

      // slight glow: CRT phosphors bloom, so lift midtones a touch
      if (mask) {
        r = Math.min(255, r + (r >> 4));
        g = Math.min(255, g + (g >> 4));
        b = Math.min(255, b + (b >> 4));
      }

      for (let dy = 0; dy < 2; dy++) {
        const dark = scanline && dy === 1;
        for (let dx = 0; dx < 2; dx++) {
          const d = ((y * 2 + dy) * dw + (x * 2 + dx)) * 4;
          let rr = r;
          let gg = g;
          let bb = b;

          if (dark) {
            // scanline gap: ~62% brightness reads as a CRT line without mush
            rr = (rr * 5) >> 3;
            gg = (gg * 5) >> 3;
            bb = (bb * 5) >> 3;
          }

          if (mask) {
            // aperture grille: each source pixel column favors one phosphor
            const phase = (x * 2 + dx) % 3;
            if (phase === 0) { gg = (gg * 7) >> 3; bb = (bb * 7) >> 3; }
            else if (phase === 1) { rr = (rr * 7) >> 3; bb = (bb * 7) >> 3; }
            else { rr = (rr * 7) >> 3; gg = (gg * 7) >> 3; }
          }

          dst[d] = rr;
          dst[d + 1] = gg;
          dst[d + 2] = bb;
          dst[d + 3] = 255;
        }
      }
    }
  }

  return { pixels: dst, width: dw, height: dh };
}
