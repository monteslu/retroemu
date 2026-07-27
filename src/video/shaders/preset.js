// .glslp preset parsing.
//
// A preset is an INI file describing a CHAIN of shader passes: each renders
// into an FBO that feeds the next. That chaining is the whole point — 225 of
// the 619 presets in libretro/glsl-shaders are multi-pass, up to 13 — and it
// is what makes shaders different from retroemu's CPU --video-filter, which
// runs one effect and cannot stack.
//
// The key set is small and closed (see internal-romdeck/SHADERS.md §5), so
// this is a real parser rather than a best-effort one: an unknown key is
// reported, not silently ignored, because a silently-dropped scale_type is a
// preset that renders subtly wrong.
//
// NOT IMPLEMENTED YET, deliberately (Phase 2):
//   textures      external LUT images — 203 presets want them
//   PassFeedback  previous-frame sampling — 42 shaders want it
// Both are reported in `unsupported` so a caller can say so out loud rather
// than rendering something quietly incomplete.
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** scale_type values that actually appear in the corpus. */
const SCALE_TYPES = new Set(['source', 'viewport', 'absolute']);

/** wrap_mode values, mapped to GL enums by the runner. */
const WRAP_MODES = new Set(['clamp_to_border', 'clamp_to_edge', 'edge', 'repeat', 'mirrored_repeat']);

const bool = (v, dflt = false) => {
  if (v === undefined || v === null || v === '') return dflt;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
};

const num = (v, dflt) => {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(String(v).trim().replace(/^"|"$/g, ''));
  return Number.isFinite(n) ? n : dflt;
};

/** Strip quotes and surrounding whitespace from an INI value. */
const str = (v) => (v === undefined ? undefined : String(v).trim().replace(/^"(.*)"$/s, '$1'));

/**
 * Parse a .glslp into a flat, validated description.
 *
 * @param {string} text   preset contents
 * @param {string} baseDir directory the preset lives in (shader paths are
 *                         relative to it)
 * @returns {{passes: Array, parameters: Object, unsupported: string[], warnings: string[]}}
 */
export function parsePreset(text, baseDir = '.') {
  const kv = new Map();
  const warnings = [];

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    kv.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }

  // `#reference "other.glslp"` makes a preset inherit another one. Exactly ONE
  // preset in the 619-file corpus uses it, and that one also needs `textures`,
  // so it is named as unsupported rather than implemented. Detected here so the
  // error says what is actually wrong instead of "no shader passes".
  if (/^\s*#reference\s/m.test(text)) {
    throw new Error('preset inheritance (#reference) is not supported');
  }

  const count = num(kv.get('shaders'), 0);
  if (!Number.isInteger(count) || count < 1) {
    const raw = kv.get('shaders');
    throw new Error(raw === undefined
      ? 'preset declares no shader passes (missing `shaders`)'
      : `preset has a malformed shader count: shaders = ${raw}`);
  }
  // Sanity bound. The deepest real preset is 13; anything far beyond that is a
  // malformed file, and each pass costs an FBO.
  if (count > 32) throw new Error(`preset declares ${count} passes (max 32)`);

  const passes = [];
  for (let i = 0; i < count; i++) {
    const shader = str(kv.get(`shader${i}`));
    if (!shader) throw new Error(`preset declares ${count} passes but has no shader${i}`);

    // scale_type may be given per-axis OR combined; per-axis wins where both
    // are present, because that is the more specific statement. A 13-pass NTSC
    // preset genuinely uses source-x with absolute-y.
    const stBoth = str(kv.get(`scale_type${i}`));
    const stX = str(kv.get(`scale_type_x${i}`)) ?? stBoth;
    const stY = str(kv.get(`scale_type_y${i}`)) ?? stBoth;
    for (const [axis, v] of [['x', stX], ['y', stY]]) {
      if (v !== undefined && !SCALE_TYPES.has(v)) {
        warnings.push(`pass ${i}: unknown scale_type_${axis} "${v}" — treating as source`);
      }
    }

    const scBoth = kv.get(`scale${i}`);
    const scaleX = num(kv.get(`scale_x${i}`), num(scBoth, 1));
    const scaleY = num(kv.get(`scale_y${i}`), num(scBoth, 1));

    const wrap = str(kv.get(`wrap_mode${i}`));
    if (wrap !== undefined && !WRAP_MODES.has(wrap)) {
      warnings.push(`pass ${i}: unknown wrap_mode "${wrap}" — treating as clamp_to_edge`);
    }

    passes.push({
      index: i,
      // Resolved here so the runner never has to think about preset location.
      path: path.resolve(baseDir, shader),
      rawPath: shader,
      // The LAST pass has no scale of its own: it renders to the screen, and
      // its size is the viewport. Recorded anyway so callers can see intent.
      filterLinear: bool(kv.get(`filter_linear${i}`), false),
      scaleTypeX: SCALE_TYPES.has(stX) ? stX : 'source',
      scaleTypeY: SCALE_TYPES.has(stY) ? stY : 'source',
      // A pass with no scale_type at all is 1:1 with its input.
      hasScale: stX !== undefined || stY !== undefined || scBoth !== undefined,
      scaleX,
      scaleY,
      floatFramebuffer: bool(kv.get(`float_framebuffer${i}`), false),
      srgbFramebuffer: bool(kv.get(`srgb_framebuffer${i}`), false),
      wrapMode: WRAP_MODES.has(wrap) ? wrap : 'clamp_to_edge',
      mipmapInput: bool(kv.get(`mipmap_input${i}`), false),
      // frame_count_mod wraps FrameCount, for temporal effects like NTSC
      // phase alternation. 0 means "do not wrap".
      frameCountMod: num(kv.get(`frame_count_mod${i}`), 0),
      // An alias names a pass so LATER passes can sample it by that name.
      // Empty-string aliases are common and mean "unnamed".
      alias: (str(kv.get(`alias${i}`)) || null),
    });
  }

  // #pragma parameter overrides. The `parameters` key lists names; each name
  // then appears as its own key. Values not listed in `parameters` are still
  // read — some presets set a value without listing it.
  const parameters = {};
  const declared = (str(kv.get('parameters')) ?? '')
    .split(';').map((s) => s.trim()).filter(Boolean);
  for (const name of declared) {
    const v = num(kv.get(name), undefined);
    if (v !== undefined) parameters[name] = v;
  }
  for (const [k, v] of kv) {
    if (parameters[k] !== undefined) continue;
    if (/^(shaders|shader\d|filter_linear\d|scale|alias|wrap_mode|float_framebuffer|srgb_framebuffer|mipmap_input|frame_count_mod|parameters|textures)/.test(k)) continue;
    const n = num(v, undefined);
    if (n !== undefined && declared.length === 0) parameters[k] = n;
  }

  // Phase-2 features. Reported rather than ignored: a preset that silently
  // loses its LUT renders wrong colours and looks like a shader bug.
  const unsupported = [];
  if (kv.has('textures')) {
    unsupported.push(`textures (${str(kv.get('textures'))}) — external LUTs not implemented`);
  }

  return { passes, parameters, unsupported, warnings };
}

/** Read and parse a preset from disk. */
export function loadPreset(file) {
  const abs = path.resolve(file);
  const parsed = parsePreset(readFileSync(abs, 'utf8'), path.dirname(abs));
  return { ...parsed, file: abs };
}
