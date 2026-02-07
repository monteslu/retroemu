import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { SDLRenderer } from './SDLRenderer.js';
import {
  RETRO_PIXEL_FORMAT_0RGB1555,
  RETRO_PIXEL_FORMAT_XRGB8888,
  RETRO_PIXEL_FORMAT_RGB565,
} from '../constants/libretro.js';

// Pre-computed lookup tables for RGB565 → RGB8 conversion
const RGB5_TO_8 = new Uint8Array(32);
const RGB6_TO_8 = new Uint8Array(64);
for (let i = 0; i < 32; i++) RGB5_TO_8[i] = (i * 255 / 31 + 0.5) | 0;
for (let i = 0; i < 64; i++) RGB6_TO_8[i] = (i * 255 / 63 + 0.5) | 0;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class VideoOutput {
  constructor(options = {}) {
    this.worker = null;
    this.workerReady = false;
    this.frameCount = 0;
    this.renderEveryN = 2; // Render every Nth frame to terminal
    this.rgbaBuffer = null;
    this.pendingFrame = false;
    this.displayAspectRatio = 4 / 3; // Default to 4:3, can be set by core
    this.contrast = 1.0; // 1.0 = no change, >1 = more contrast

    // Render options (3 independent settings)
    this.symbols = 'block';  // block, half, ascii, solid, stipple, quad, sextant, octant, braille
    this.colors = 'true';    // true, 256, 16, 2
    this.fgOnly = false;     // foreground color only
    this.dither = false;     // Floyd-Steinberg dithering

    // Video output mode
    this.mode = options.video || 'terminal'; // 'terminal' | 'sdl' | 'both'
    this.scale = options.scale || 2;
    this.sdlRenderer = null;
    
    // For vibe-eyes integration later
    this.onFrameCallback = options.onFrame || null;
  }

  async init(width, height) {
    // Init SDL if requested
    if (this.mode === 'sdl' || this.mode === 'both') {
      // We might not know width/height yet if init() is called early
      // But init() in VideoOutput seems to be async and called before core load?
      // Wait, width/height come from the core later?
      // VideoOutput.init() in cli.js is called before host.loadAndStart().
      // But the core provides geometry info only after loading.
      // SDL window needs dimensions.
      // We should probably delay SDL init until first frame or pass geometry separately?
      
      // Actually, cli.js calls videoOutput.init() without args.
      // The worker is initialized there.
      
      // We need to lazy-init SDL or update init signature.
      // The core calls init() or similar?
      // Let's check LibretroHost.js to see when it knows dimensions.
    }

    return new Promise((resolve, reject) => {
      this.worker = new Worker(join(__dirname, 'videoWorker.js'));

      this.worker.on('message', (msg) => {
        if (msg.type === 'ready') {
          this.workerReady = true;
          resolve();
        } else if (msg.type === 'frame') {
          this.pendingFrame = false;
          process.stdout.write(`\x1b[H${msg.ansi}`);
        } else if (msg.type === 'error') {
          if (!this.workerReady) {
            reject(new Error(msg.message));
          } else {
            console.error('Video worker error:', msg.message);
          }
        }
      });

      this.worker.on('error', (err) => {
        if (!this.workerReady) {
          reject(err);
        } else {
          console.error('Video worker error:', err.message);
        }
      });
    });
  }

  setFrameSkip(n) {
    this.renderEveryN = Math.max(1, n | 0);
  }

  setAspectRatio(ratio) {
    this.displayAspectRatio = ratio > 0 ? ratio : 4 / 3;
  }

  setContrast(value) {
    this.contrast = Math.max(0.5, Math.min(3.0, value));
  }

  setSymbols(symbols) {
    const validSymbols = ['block', 'half', 'ascii', 'solid', 'stipple', 'quad', 'sextant', 'octant', 'braille'];
    this.symbols = validSymbols.includes(symbols) ? symbols : 'block';
  }

  setColors(colors) {
    const validColors = ['true', '256', '16', '2'];
    this.colors = validColors.includes(colors) ? colors : 'true';
  }

  setFgOnly(enabled) {
    this.fgOnly = !!enabled;
  }

  setDither(enabled) {
    this.dither = !!enabled;
  }

  onFrame(wasmModule, dataPtr, width, height, pitch, pixelFormat) {
    this.frameCount++;

    // Lazy init SDL renderer on first frame when we know dimensions
    if (!this.sdlRenderer && (this.mode === 'sdl' || this.mode === 'both')) {
      this.sdlRenderer = new SDLRenderer({ title: 'retroemu', scale: this.scale });
      this.sdlRenderer.init(width, height);
    }

    const renderToTerminal = (this.mode === 'terminal' || this.mode === 'both') && 
                             (this.frameCount % this.renderEveryN === 0) &&
                             !this.pendingFrame && this.workerReady;
                             
    const renderToSdl = (this.mode === 'sdl' || this.mode === 'both') && this.sdlRenderer;

    if (!renderToTerminal && !renderToSdl) return;

    // Convert to RGBA on main thread (known working)
    const rgbaData = this._convertToRGBA(wasmModule, dataPtr, width, height, pitch, pixelFormat);

    // SDL Render (Synchronous)
    if (renderToSdl) {
      this.sdlRenderer.render(rgbaData, width, height);
      
      // Callback for vibe-eyes integration (future)
      if (this.onFrameCallback) {
        this.onFrameCallback(rgbaData, width, height);
      }
    }

    // Terminal Render (Async Worker)
    if (renderToTerminal) {
      const termCols = process.stdout.columns || 80;
      const termRows = (process.stdout.rows || 24) - 4;

      const sourceAspect = this.displayAspectRatio;
      const termCharAspect = 2.0;

      let usedCols, usedRows;
      const rowsNeededForWidth = termCols / (sourceAspect * termCharAspect);

      if (rowsNeededForWidth <= termRows) {
        usedCols = termCols;
        usedRows = Math.floor(rowsNeededForWidth);
      } else {
        usedRows = termRows;
        usedCols = Math.floor(termRows * sourceAspect * termCharAspect);
      }

      this.pendingFrame = true;
      
      // Only transfer buffer if we are NOT rendering to SDL (which needs it)
      // If rendering to both, we let the worker clone it (slower but safe)
      const transferList = renderToSdl ? [] : [rgbaData.buffer];
      
      this.worker.postMessage({
        type: 'render',
        rgbaData: rgbaData.buffer,
        width,
        height,
        termCols: usedCols,
        termRows: usedRows,
        contrast: this.contrast,
        symbols: this.symbols,
        colors: this.colors,
        fgOnly: this.fgOnly,
        dither: this.dither
      }, transferList);
      
      // If we transferred, we need a new buffer next time
      if (!renderToSdl) {
        this.rgbaBuffer = null;
      }
    }
  }

  _convertToRGBA(wasmModule, dataPtr, width, height, pitch, pixelFormat) {
    const totalPixels = width * height;

    if (!this.rgbaBuffer || this.rgbaBuffer.length !== totalPixels * 4) {
      this.rgbaBuffer = new Uint8ClampedArray(totalPixels * 4);
    }

    const rgba = this.rgbaBuffer;

    switch (pixelFormat) {
      case RETRO_PIXEL_FORMAT_XRGB8888:
        this._convertXRGB8888(wasmModule, dataPtr, width, height, pitch, rgba);
        break;
      case RETRO_PIXEL_FORMAT_RGB565:
        this._convertRGB565(wasmModule, dataPtr, width, height, pitch, rgba);
        break;
      case RETRO_PIXEL_FORMAT_0RGB1555:
        this._convert0RGB1555(wasmModule, dataPtr, width, height, pitch, rgba);
        break;
    }

    return rgba;
  }

  _convertXRGB8888(mod, dataPtr, width, height, pitch, rgba) {
    for (let y = 0; y < height; y++) {
      const srcRowByteOffset = dataPtr + y * pitch;
      const dstRowOffset = y * width * 4;

      for (let x = 0; x < width; x++) {
        const pixel = mod.HEAPU32[(srcRowByteOffset >> 2) + x];
        const dst = dstRowOffset + x * 4;
        rgba[dst]     = (pixel >> 16) & 0xFF;
        rgba[dst + 1] = (pixel >> 8) & 0xFF;
        rgba[dst + 2] = pixel & 0xFF;
        rgba[dst + 3] = 255;
      }
    }
  }

  _convertRGB565(mod, dataPtr, width, height, pitch, rgba) {
    for (let y = 0; y < height; y++) {
      const srcRowByteOffset = dataPtr + y * pitch;
      const dstRowOffset = y * width * 4;

      for (let x = 0; x < width; x++) {
        const pixel = mod.HEAPU16[(srcRowByteOffset >> 1) + x];
        const dst = dstRowOffset + x * 4;
        rgba[dst]     = RGB5_TO_8[(pixel >> 11) & 0x1F];
        rgba[dst + 1] = RGB6_TO_8[(pixel >> 5) & 0x3F];
        rgba[dst + 2] = RGB5_TO_8[pixel & 0x1F];
        rgba[dst + 3] = 255;
      }
    }
  }

  _convert0RGB1555(mod, dataPtr, width, height, pitch, rgba) {
    for (let y = 0; y < height; y++) {
      const srcRowByteOffset = dataPtr + y * pitch;
      const dstRowOffset = y * width * 4;

      for (let x = 0; x < width; x++) {
        const pixel = mod.HEAPU16[(srcRowByteOffset >> 1) + x];
        const dst = dstRowOffset + x * 4;
        rgba[dst]     = RGB5_TO_8[(pixel >> 10) & 0x1F];
        rgba[dst + 1] = RGB5_TO_8[(pixel >> 5) & 0x1F];
        rgba[dst + 2] = RGB5_TO_8[pixel & 0x1F];
        rgba[dst + 3] = 255;
      }
    }
  }

  destroy() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.workerReady = false;
    if (this.sdlRenderer) {
      this.sdlRenderer.destroy();
      this.sdlRenderer = null;
    }
  }
}
