import { parentPort } from 'worker_threads';

// Chafa constants
const CHAFA_CANVAS_MODE_TRUECOLOR = 0;
const CHAFA_SYMBOL_TAG_SPACE = 0x1;
const CHAFA_SYMBOL_TAG_BLOCK = 0x8;
const CHAFA_SYMBOL_TAG_BORDER = 0x10;
const CHAFA_SYMBOL_TAG_VHALF = 0x200; // Vertical half blocks (▀▄) - fastest mode
const CHAFA_SYMBOL_TAG_BRAILLE = 0x800; // Braille characters
const CHAFA_SYMBOL_TAG_ASCII = 0x4000; // ASCII characters

const CHAFA_CANVAS_MODE_FGBG = 5; // 2-color mode (foreground/background)
const CHAFA_DITHER_MODE_NONE = 0;
const CHAFA_DITHER_MODE_DIFFUSION = 2; // Floyd-Steinberg dithering

let chafa = null;
let canvasConfig = 0;
let symbolMap = 0;
let canvas = 0;
let lastWidth = 0;
let lastHeight = 0;
let lastRenderMode = 'detailed';
let currentCanvasMode = CHAFA_CANVAS_MODE_TRUECOLOR;
let currentDitherMode = CHAFA_DITHER_MODE_NONE;

function applyContrast(rgbaData, contrast) {
  if (contrast === 1.0) return rgbaData;

  const result = new Uint8ClampedArray(rgbaData.length);
  for (let i = 0; i < rgbaData.length; i += 4) {
    // Apply contrast to RGB, leave alpha unchanged
    result[i]     = Math.min(255, Math.max(0, ((rgbaData[i] - 128) * contrast) + 128));
    result[i + 1] = Math.min(255, Math.max(0, ((rgbaData[i + 1] - 128) * contrast) + 128));
    result[i + 2] = Math.min(255, Math.max(0, ((rgbaData[i + 2] - 128) * contrast) + 128));
    result[i + 3] = rgbaData[i + 3];
  }
  return result;
}

function createSymbolMap(mode) {
  if (symbolMap) {
    chafa._chafa_symbol_map_unref(symbolMap);
  }
  symbolMap = chafa._chafa_symbol_map_new();

  // Reset to defaults
  currentCanvasMode = CHAFA_CANVAS_MODE_TRUECOLOR;
  currentDitherMode = CHAFA_DITHER_MODE_NONE;

  if (mode === 'fast') {
    // Use only vertical half blocks - fastest possible rendering
    chafa._chafa_symbol_map_add_by_tags(symbolMap, CHAFA_SYMBOL_TAG_SPACE | CHAFA_SYMBOL_TAG_VHALF);
  } else if (mode === 'ascii') {
    // ASCII characters only
    chafa._chafa_symbol_map_add_by_tags(symbolMap, CHAFA_SYMBOL_TAG_SPACE | CHAFA_SYMBOL_TAG_ASCII);
  } else if (mode === 'braille') {
    // Braille characters, black and white
    chafa._chafa_symbol_map_add_by_tags(symbolMap, CHAFA_SYMBOL_TAG_BRAILLE);
    currentCanvasMode = CHAFA_CANVAS_MODE_FGBG;
  } else if (mode === 'braille-dither') {
    // Braille characters with dithering for better grayscale
    chafa._chafa_symbol_map_add_by_tags(symbolMap, CHAFA_SYMBOL_TAG_BRAILLE);
    currentCanvasMode = CHAFA_CANVAS_MODE_FGBG;
    currentDitherMode = CHAFA_DITHER_MODE_DIFFUSION;
  } else {
    // Detailed mode - block symbols for better quality
    chafa._chafa_symbol_map_add_by_tags(symbolMap, CHAFA_SYMBOL_TAG_SPACE | CHAFA_SYMBOL_TAG_BLOCK | CHAFA_SYMBOL_TAG_BORDER);
  }
}

async function initChafa() {
  const chafaModule = await import('@monteslu/chafa-wasm');
  chafa = chafaModule.default || chafaModule;
  if (typeof chafa === 'function') {
    chafa = await chafa();
  }

  createSymbolMap('detailed');

  parentPort.postMessage({ type: 'ready' });
}

function renderFrame(rgbaData, width, height, termCols, termRows, contrast, renderMode = 'detailed') {
  if (!chafa) return null;

  // Apply contrast boost if needed
  if (contrast && contrast !== 1.0) {
    rgbaData = applyContrast(rgbaData, contrast);
  }

  // Recreate symbol map if render mode changed
  if (lastRenderMode !== renderMode) {
    createSymbolMap(renderMode);
    lastRenderMode = renderMode;
    // Force canvas config recreation
    lastWidth = 0;
    lastHeight = 0;
  }

  // Recreate canvas config if terminal size changed
  if (lastWidth !== termCols || lastHeight !== termRows) {
    if (canvasConfig) {
      chafa._chafa_canvas_config_unref(canvasConfig);
    }
    if (canvas) {
      chafa._chafa_canvas_unref(canvas);
      canvas = 0;
    }

    canvasConfig = chafa._chafa_canvas_config_new();
    chafa._chafa_canvas_config_set_geometry(canvasConfig, termCols, termRows);
    chafa._chafa_canvas_config_set_canvas_mode(canvasConfig, currentCanvasMode);
    chafa._chafa_canvas_config_set_symbol_map(canvasConfig, symbolMap);
    if (currentDitherMode !== CHAFA_DITHER_MODE_NONE) {
      chafa._chafa_canvas_config_set_dither_mode(canvasConfig, currentDitherMode);
    }

    lastWidth = termCols;
    lastHeight = termRows;
  }

  if (!canvas) {
    canvas = chafa._chafa_canvas_new(canvasConfig);
  }

  // Allocate and copy RGBA data to chafa's heap
  const dataPtr = chafa._malloc(rgbaData.length);
  chafa.HEAPU8.set(rgbaData, dataPtr);

  // Draw pixels
  chafa._chafa_canvas_set_contents_rgba8(canvas, dataPtr, width, height, width * 4);
  chafa._free(dataPtr);

  // Build ANSI output
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
      msg.renderMode || 'detailed'
    );
    if (ansi) {
      parentPort.postMessage({ type: 'frame', ansi });
    }
  }
});

initChafa().catch(err => {
  parentPort.postMessage({ type: 'error', message: err.message });
});
