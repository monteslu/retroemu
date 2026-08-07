// Display-aspect policy: what shape should the picture be PRESENTED at?
//
// A framebuffer's pixel grid is not the shape the game was authored for.
// Consoles fed a 4:3 CRT television and their pixels are not square (NES
// 256x240 shown square-pixel is 16:15 — visibly narrow); handheld LCDs have
// square pixels, so their native framebuffer ratio IS the physical screen
// shape. Mirrors romdev-core-runner's `tvAspectFor` policy so the whole
// ecosystem presents games identically.
//
// Modes:
//   'tv'     (default) the physical output medium the system was built for
//   'native' square pixels — scale the raw framebuffer ratio
//   'core'   whatever the core reports (fb ratio when it reports 0/garbage)

// Systems designed for a 4:3 television (or a 4:3 monitor).
const TV_4_3 = new Set([
  'nes', 'snes', 'genesis', 'sms', 'sg1000', 'pce',
  'atari2600', 'atari5200', 'atari7800', 'atari800',
  'coleco', 'msx', 'spectrum', 'psx', 'n64', 'dreamcast', 'gametank',
]);

// Handhelds and native-shape systems: the framebuffer ratio is the physical
// screen shape (square-pixel LCDs; pico8's square screen; vectrex's own CRT
// as the core presents it; jsgame/wasmcart author for exact pixels).
const NATIVE_SHAPE = new Set([
  'gb', 'gbc', 'gba', 'lynx', 'ngp', 'ngpc', 'wswan', 'wswanc',
  'pico8', 'vectrex', 'jsgame', 'wasmcart',
]);

/**
 * The aspect ratio to present at, per policy mode.
 *
 * @param {'tv'|'native'|'core'} mode presentation policy
 * @param {string|null} system SystemDetector id ('nes', 'gb', ...)
 * @param {number} fbWidth framebuffer width in pixels
 * @param {number} fbHeight framebuffer height in pixels
 * @param {number} [coreAspect] the core-reported display aspect (0 = unknown)
 * @returns {number} width/height ratio, always finite and > 0
 */
export function displayAspectFor(mode, system, fbWidth, fbHeight, coreAspect = 0) {
  const fbRatio = fbWidth > 0 && fbHeight > 0 ? fbWidth / fbHeight : 4 / 3;
  const reported = Number.isFinite(coreAspect) && coreAspect > 0 ? coreAspect : fbRatio;
  if (mode === 'native') return fbRatio;
  if (mode === 'core') return reported;
  // 'tv': the physical medium.
  if (TV_4_3.has(system)) return 4 / 3;
  if (NATIVE_SHAPE.has(system)) return fbRatio;
  // Game Gear: 160x144 shown stretched on a wider-than-10:9 LCD (same value
  // romdev-core-runner uses).
  if (system === 'gg') return 1.20;
  // Unknown system: trust the core, fall back to the framebuffer's own shape.
  return reported;
}

/** Normalize a user-supplied --aspect value; null when unrecognized. */
export function parseAspectMode(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'tv') return 'tv';
  if (v === 'native' || v === 'fb') return 'native';
  if (v === 'core') return 'core';
  return null;
}
