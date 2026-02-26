import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  RETRO_PIXEL_FORMAT_0RGB1555,
  RETRO_PIXEL_FORMAT_XRGB8888,
  RETRO_PIXEL_FORMAT_RGB565,
} from '../constants/libretro.js';
import { SDLRenderer } from './SDLRenderer.js';

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

    // Video output mode: 'terminal' | 'sdl' | 'both'
    this.mode = options.video || 'terminal';
    this.sdlScale = options.scale || 2;
    this.sdlRenderer = null;

    // Callback for frame capture (future vibe-eyes integration)
    this.onFrameCallback = options.onFrame || null;

    // Render options (3 independent settings)
    this.symbols = 'block';  // block, half, ascii, ascii+block, solid, stipple, quad, sextant, octant, braille
    this.colors = 'true';    // true, 256, 16, 2
    this.fgOnly = false;     // foreground color only
    this.dither = false;     // Floyd-Steinberg dithering

    // FPS tracking
    this.lastFrameTime = 0;
    this.displayFps = 0;
    this.fpsSmoothing = 0.9; // Smoothing factor for FPS display
  }

  async init() {
    // Initialize terminal worker if needed
    if (this.mode === 'terminal' || this.mode === 'both') {
      await this._initTerminalWorker();
    }

    // Initialize SDL window EARLY if SDL mode is enabled
    // This MUST happen before gamepad-node accesses sdl.controller, or window events break
    if (this.mode === 'sdl' || this.mode === 'both') {
      // Use common retro console dimensions as initial size (will adapt on first frame)
      this.sdlRenderer = new SDLRenderer({
        title: 'retroemu',
        scale: this.sdlScale,
      });
      this.sdlRenderer.init(256, 224);
    }
  }

  async _initTerminalWorker() {
    return new Promise((resolve, reject) => {
      this.worker = new Worker(join(__dirname, 'videoWorker.js'));

      this.worker.on('message', (msg) => {
        if (msg.type === 'ready') {
          this.workerReady = true;
          resolve();
        } else if (msg.type === 'frame') {
          this.pendingFrame = false;

          // Calculate display FPS
          const now = performance.now();
          if (this.lastFrameTime > 0) {
            const instantFps = 1000 / (now - this.lastFrameTime);
            this.displayFps = this.displayFps * this.fpsSmoothing + instantFps * (1 - this.fpsSmoothing);
          }
          this.lastFrameTime = now;

          // Render frame, then status line below
          const termRows = process.stdout.rows || 24;
          const fps = this.displayFps > 0 ? this.displayFps.toFixed(0) : '--';
          const statusLine = `\x1b[${termRows};1H\x1b[0m\x1b[36m ${this.nativeWidth}x${this.nativeHeight} -> ${this.termCols}x${this.termRows} | ${fps}fps | ${this.symbols} ${this.colors}${this.fgOnly ? ' fg' : ''}\x1b[K\x1b[0m`;
          process.stdout.write(`\x1b[H${msg.ansi}${statusLine}`);
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
    const validSymbols = ['block', 'half', 'ascii', 'ascii+block', 'solid', 'stipple', 'quad', 'sextant', 'octant', 'braille', 'matrix'];
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

    // For SDL-only mode, render every frame for smoothness
    // For terminal modes, use frame skip
    const useTerminal = this.mode === 'terminal' || this.mode === 'both';
    const useSDL = this.mode === 'sdl' || this.mode === 'both';

    // Skip frame check for terminal rendering
    const skipTerminalFrame = useTerminal && (this.frameCount % this.renderEveryN !== 0);
    const terminalBusy = useTerminal && (this.pendingFrame || !this.workerReady);

    // If nothing to do this frame, return early
    if (!useSDL && (skipTerminalFrame || terminalBusy)) return;

    // Convert to RGBA on main thread
    const rgbaData = this._convertToRGBA(wasmModule, dataPtr, width, height, pitch, pixelFormat);

    // SDL rendering (every frame for smoothness)
    if (useSDL && this.sdlRenderer) {
      this.sdlRenderer.render(rgbaData, width, height);
    }

    // Frame callback for external consumers (future vibe-eyes integration)
    if (this.onFrameCallback) {
      this.onFrameCallback(rgbaData, width, height);
    }

    // Terminal rendering (with frame skip)
    if (useTerminal && !skipTerminalFrame && !terminalBusy) {
      const termCols = process.stdout.columns || 80;
      const termRows = (process.stdout.rows || 24) - 1;

      // Calculate dimensions that preserve display aspect ratio (4:3 for most retro consoles)
      // Terminal chars are ~2:1 (height:width), so multiply width by 2
      const sourceAspect = this.displayAspectRatio;
      const termCharAspect = 2.0;

      let usedCols, usedRows;
      const rowsNeededForWidth = termCols / (sourceAspect * termCharAspect);

      if (rowsNeededForWidth <= termRows) {
        // Width-constrained: use full width, calculate height
        usedCols = termCols;
        usedRows = Math.floor(rowsNeededForWidth);
      } else {
        // Height-constrained: use full height, calculate width
        usedRows = termRows;
        usedCols = Math.floor(termRows * sourceAspect * termCharAspect);
      }

      // Store for status display
      this.nativeWidth = width;
      this.nativeHeight = height;
      this.termCols = usedCols;
      this.termRows = usedRows;

      this.pendingFrame = true;
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
      }, [rgbaData.buffer]);

      this.rgbaBuffer = null; // Need new buffer since we transferred
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

  getSDLWindow() {
    return this.sdlRenderer?.getWindow() || null;
  }

  getSDL() {
    return this.sdlRenderer ? this.sdlRenderer.sdl : null;
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
