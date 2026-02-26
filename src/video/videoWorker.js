import { parentPort } from 'worker_threads';

// Canvas modes
const CHAFA_CANVAS_MODE_TRUECOLOR = 0;
const CHAFA_CANVAS_MODE_INDEXED_256 = 1;
const CHAFA_CANVAS_MODE_INDEXED_16 = 3;
const CHAFA_CANVAS_MODE_FGBG = 5;

// Dither modes
const CHAFA_DITHER_MODE_NONE = 0;
const CHAFA_DITHER_MODE_DIFFUSION = 2;

// Optimization flags (bitmask)
const CHAFA_OPTIMIZATION_NONE = 0;
const CHAFA_OPTIMIZATION_REUSE_ATTRIBUTES = 1;  // Suppress redundant SGR control sequences
const CHAFA_OPTIMIZATION_SKIP_CELLS = 2;        // Reserved for future use
const CHAFA_OPTIMIZATION_REPEAT_CELLS = 4;      // Use REP sequence for repeated cells
const CHAFA_OPTIMIZATION_ALL = 7;               // All optimizations enabled

// Symbol tags - bitmask flags
const CHAFA_SYMBOL_TAG_SPACE     = 0x1;
const CHAFA_SYMBOL_TAG_SOLID     = 0x2;
const CHAFA_SYMBOL_TAG_STIPPLE   = 0x4;
const CHAFA_SYMBOL_TAG_BLOCK     = 0x8;
const CHAFA_SYMBOL_TAG_BORDER    = 0x10;
const CHAFA_SYMBOL_TAG_QUAD      = 0x80;
const CHAFA_SYMBOL_TAG_VHALF     = 0x200;
const CHAFA_SYMBOL_TAG_BRAILLE   = 0x800;
const CHAFA_SYMBOL_TAG_ASCII     = 0x4000;
const CHAFA_SYMBOL_TAG_SEXTANT   = 0x400000;
const CHAFA_SYMBOL_TAG_OCTANT    = 0x4000000;

// Symbol set definitions
const SYMBOL_SETS = {
  block:         CHAFA_SYMBOL_TAG_SPACE | CHAFA_SYMBOL_TAG_BLOCK | CHAFA_SYMBOL_TAG_BORDER,
  half:          CHAFA_SYMBOL_TAG_SPACE | CHAFA_SYMBOL_TAG_VHALF,
  ascii:         CHAFA_SYMBOL_TAG_SPACE | CHAFA_SYMBOL_TAG_ASCII,
  'ascii+block': CHAFA_SYMBOL_TAG_SPACE | CHAFA_SYMBOL_TAG_BLOCK | CHAFA_SYMBOL_TAG_ASCII,
  solid:      CHAFA_SYMBOL_TAG_SPACE,
  stipple:    CHAFA_SYMBOL_TAG_SPACE | CHAFA_SYMBOL_TAG_SOLID | CHAFA_SYMBOL_TAG_STIPPLE,
  quad:       CHAFA_SYMBOL_TAG_SPACE | CHAFA_SYMBOL_TAG_QUAD,
  sextant:    CHAFA_SYMBOL_TAG_SPACE | CHAFA_SYMBOL_TAG_SEXTANT,
  octant:     CHAFA_SYMBOL_TAG_SPACE | CHAFA_SYMBOL_TAG_OCTANT,
  braille:    CHAFA_SYMBOL_TAG_BRAILLE,
};

// Color mode definitions
const COLOR_MODES = {
  'true': CHAFA_CANVAS_MODE_TRUECOLOR,
  '256':  CHAFA_CANVAS_MODE_INDEXED_256,
  '16':   CHAFA_CANVAS_MODE_INDEXED_16,
  '2':    CHAFA_CANVAS_MODE_FGBG,
};

let chafa = null;
let canvasConfig = 0;
let symbolMap = 0;
let canvas = 0;
let lastWidth = 0;
let lastHeight = 0;

// Current settings
let lastSymbols = '';
let lastColors = '';
let lastFgOnly = false;
let lastDither = false;

const MATRIX_CHARS = ' ｦｱｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789█';

// Register glyph bitmaps for each matrix character so chafa can do
// proper pixel-to-glyph shape matching with these custom code points.
function addMatrixGlyphs() {
  const GLYPH_W = 8;
  const GLYPH_H = 8;
  const totalPixels = GLYPH_W * GLYPH_H;
  const bufSize = totalPixels * 4;
  const stride = GLYPH_W * 4;

  for (let i = 0; i < MATRIX_CHARS.length; i++) {
    const codePoint = MATRIX_CHARS.codePointAt(i);
    // Space (index 0) gets 0% density, last char gets ~100%
    const density = i / (MATRIX_CHARS.length - 1);
    const fillCount = Math.round(density * totalPixels);

    // Build a deterministic scatter pattern seeded by character index
    const order = Array.from({ length: totalPixels }, (_, p) => p);
    for (let j = totalPixels - 1; j > 0; j--) {
      const k = (((j * 2654435761) + (i * 2246822519)) >>> 0) % (j + 1);
      const tmp = order[j]; order[j] = order[k]; order[k] = tmp;
    }

    const bitmap = new Uint8Array(bufSize);
    for (let f = 0; f < fillCount; f++) {
      const off = order[f] * 4;
      bitmap[off] = bitmap[off + 1] = bitmap[off + 2] = bitmap[off + 3] = 255;
    }

    const ptr = chafa._malloc(bufSize);
    chafa.HEAPU8.set(bitmap, ptr);
    chafa._chafa_symbol_map_add_glyph(symbolMap, codePoint, 0, ptr, GLYPH_W, GLYPH_H, stride);
    chafa._free(ptr);
  }
}

// Build ANSI output directly from canvas cells — only fg colors on black bg.
// Bypasses chafa's ANSI builder entirely to avoid bg color issues.
function buildMatrixAnsi(termCols, termRows, colors) {
  let out = '\x1b[48;2;0;0;0m';
  const fgPtr = chafa._malloc(4);
  const bgPtr = chafa._malloc(4);
  let lastFg = -1;

  for (let y = 0; y < termRows; y++) {
    for (let x = 0; x < termCols; x++) {
      const ch = chafa._chafa_canvas_get_char_at(canvas, x, y);
      chafa._chafa_canvas_get_colors_at(canvas, x, y, fgPtr, bgPtr);
      // get_colors_at always returns packed RGB regardless of canvas mode
      const fg = chafa.HEAPU8[fgPtr] | (chafa.HEAPU8[fgPtr + 1] << 8) | (chafa.HEAPU8[fgPtr + 2] << 16) | (chafa.HEAPU8[fgPtr + 3] << 24);

      if (fg !== lastFg) {
        const r = (fg >> 16) & 0xFF;
        const g = (fg >> 8) & 0xFF;
        const b = fg & 0xFF;
        out += `\x1b[38;2;${r};${g};${b}m`;
        lastFg = fg;
      }
      out += String.fromCodePoint(ch);
    }
    out += '\x1b[0m\x1b[K';
    if (y < termRows - 1) out += '\n\x1b[48;2;0;0;0m';
    lastFg = -1;
  }

  chafa._free(fgPtr);
  chafa._free(bgPtr);
  return out;
}

function applyGreenScale(rgbaData) {
  const result = new Uint8ClampedArray(rgbaData.length);
  for (let i = 0; i < rgbaData.length; i += 4) {
    const lum = (0.299 * rgbaData[i] + 0.587 * rgbaData[i + 1] + 0.114 * rgbaData[i + 2]) | 0;
    result[i]     = 0;
    result[i + 1] = lum;
    result[i + 2] = 0;
    result[i + 3] = rgbaData[i + 3];
  }
  return result;
}

function applyContrast(rgbaData, contrast) {
  if (contrast === 1.0) return rgbaData;

  const result = new Uint8ClampedArray(rgbaData.length);
  for (let i = 0; i < rgbaData.length; i += 4) {
    result[i]     = Math.min(255, Math.max(0, ((rgbaData[i] - 128) * contrast) + 128));
    result[i + 1] = Math.min(255, Math.max(0, ((rgbaData[i + 1] - 128) * contrast) + 128));
    result[i + 2] = Math.min(255, Math.max(0, ((rgbaData[i + 2] - 128) * contrast) + 128));
    result[i + 3] = rgbaData[i + 3];
  }
  return result;
}

function setupSymbolMap(symbols) {
  if (symbolMap) {
    chafa._chafa_symbol_map_unref(symbolMap);
  }
  symbolMap = chafa._chafa_symbol_map_new();

  if (symbols === 'matrix') {
    // Register code point ranges, then provide glyph bitmaps
    chafa._chafa_symbol_map_add_by_range(symbolMap, 0x0020, 0x0020); // space
    chafa._chafa_symbol_map_add_by_range(symbolMap, 0xFF66, 0xFF9D); // half-width katakana
    chafa._chafa_symbol_map_add_by_range(symbolMap, 0x0030, 0x0039); // digits
    chafa._chafa_symbol_map_add_by_range(symbolMap, 0x2588, 0x2588); // solid block █
    addMatrixGlyphs();
  } else {
    const tags = SYMBOL_SETS[symbols] || SYMBOL_SETS.block;
    chafa._chafa_symbol_map_add_by_tags(symbolMap, tags);
  }
}

function setupCanvas(termCols, termRows, symbols, colors, fgOnly, dither) {
  const settingsChanged = symbols !== lastSymbols || colors !== lastColors ||
                          fgOnly !== lastFgOnly || dither !== lastDither;
  const sizeChanged = termCols !== lastWidth || termRows !== lastHeight;

  if (!settingsChanged && !sizeChanged && canvas) {
    return; // No changes needed
  }

  // Rebuild symbol map if symbols changed
  if (symbols !== lastSymbols) {
    setupSymbolMap(symbols);
  }

  // Rebuild canvas config
  if (canvasConfig) {
    chafa._chafa_canvas_config_unref(canvasConfig);
  }
  if (canvas) {
    chafa._chafa_canvas_unref(canvas);
    canvas = 0;
  }

  const canvasMode = COLOR_MODES[colors] || CHAFA_CANVAS_MODE_TRUECOLOR;

  canvasConfig = chafa._chafa_canvas_config_new();
  chafa._chafa_canvas_config_set_geometry(canvasConfig, termCols, termRows);
  chafa._chafa_canvas_config_set_canvas_mode(canvasConfig, canvasMode);
  chafa._chafa_canvas_config_set_symbol_map(canvasConfig, symbolMap);
  chafa._chafa_canvas_config_set_optimizations(canvasConfig, CHAFA_OPTIMIZATION_ALL);

  if (fgOnly) {
    chafa._chafa_canvas_config_set_fg_only_enabled(canvasConfig, 1);
  }
  if (dither) {
    chafa._chafa_canvas_config_set_dither_mode(canvasConfig, CHAFA_DITHER_MODE_DIFFUSION);
  }

  canvas = chafa._chafa_canvas_new(canvasConfig);

  lastSymbols = symbols;
  lastColors = colors;
  lastFgOnly = fgOnly;
  lastDither = dither;
  lastWidth = termCols;
  lastHeight = termRows;
}

async function initChafa() {
  const chafaModule = await import('@monteslu/chafa-wasm');
  chafa = chafaModule.default || chafaModule;
  if (typeof chafa === 'function') {
    chafa = await chafa();
  }
  parentPort.postMessage({ type: 'ready' });
}

function renderFrame(rgbaData, width, height, termCols, termRows, contrast, symbols, colors, fgOnly, dither) {
  if (!chafa) return null;

  if (contrast && contrast !== 1.0) {
    rgbaData = applyContrast(rgbaData, contrast);
  }

  if (symbols === 'matrix') {
    rgbaData = applyGreenScale(rgbaData);
  }

  setupCanvas(termCols, termRows, symbols, colors, fgOnly, dither);

  const dataPtr = chafa._malloc(rgbaData.length);
  chafa.HEAPU8.set(rgbaData, dataPtr);
  chafa._chafa_canvas_set_contents_rgba8(canvas, dataPtr, width, height, width * 4);
  chafa._free(dataPtr);

  if (symbols === 'matrix') {
    return buildMatrixAnsi(termCols, termRows, colors);
  }

  const gsPtr = chafa._chafa_canvas_build_ansi(canvas);
  if (!gsPtr) return null;

  const strPtr = chafa._g_string_free_and_steal(gsPtr);
  const ansi = chafa.UTF8ToString(strPtr);
  chafa._free(strPtr);

  return ansi;
}

parentPort.on('message', (msg) => {
  if (msg.type === 'render') {
    const ansi = renderFrame(
      new Uint8ClampedArray(msg.rgbaData),
      msg.width,
      msg.height,
      msg.termCols,
      msg.termRows,
      msg.contrast || 1.0,
      msg.symbols || 'block',
      msg.colors || 'true',
      msg.fgOnly || false,
      msg.dither || false
    );
    if (ansi) {
      parentPort.postMessage({ type: 'frame', ansi });
    }
  }
});

initChafa().catch(err => {
  parentPort.postMessage({ type: 'error', message: err.message });
});
