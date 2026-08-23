import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  RETRO_PIXEL_FORMAT_0RGB1555,
  RETRO_PIXEL_FORMAT_XRGB8888,
  RETRO_PIXEL_FORMAT_RGB565,
} from '../constants/libretro.js';
import { SDLRenderer } from './SDLRenderer.js';
import { displayAspectFor } from './aspect.js';
import { applyFilter, isFilter } from './filters.js';

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
    this.contrast = 1.0; // 1.0 = no change, >1 = more contrast

    // Video output mode: 'terminal' | 'sdl' | 'both'
    this.mode = options.video || 'terminal';
    // Presentation policy: 'tv' (physical output medium — 4:3 CRT for
    // consoles, the LCD's own shape for handhelds) | 'native' (square
    // pixels) | 'core' (core-reported). See src/video/aspect.js.
    this.aspectMode = options.aspectMode || 'tv';
    this.sdlScale = options.scale === 'auto' ? 'auto' : (options.scale || 2);
    this.sdlAccelerated = options.accelerated !== false; // default true
    this.sdlRenderer = null;
    this.initWidth = options.initWidth || 0;
    this.initHeight = options.initHeight || 0;
    this.fullscreen = !!options.fullscreen;
    this.opengl = !!options.opengl;
    // The system id (SystemDetector), when the caller already knows it —
    // lets the window OPEN at the right shape instead of snapping to it
    // after the core loads. Refined by setAspectFromCore either way.
    this.system = options.system || null;
    this.displayAspectRatio = displayAspectFor(
      this.aspectMode, this.system,
      this.initWidth || 256, this.initHeight || 224,
    );

    // --shader <preset.glslp>: GPU shader chain. Mutually exclusive with the
    // CPU --video-filter, the same way RetroArch treats them (they are
    // different subsystems; see internal-romdeck/SHADERS.md §1).
    this.shaderPreset = options.shader || null;
    this.glRenderer = null;

    // Callback for frame capture (future vibe-eyes integration)
    this.onFrameCallback = options.onFrame || null;
    this.onDisplayChange = options.onDisplayChange || null;
    // Optional synchronous whole-frame transform. Active Bezels use this to
    // replace the core-sized picture with their complete 16:9 composition.
    // It is null on the ordinary path, so existing sessions pay no copy or
    // dispatch cost beyond this branch.
    this.frameProcessor = null;
    this.frameProcessorEffectScope = 'scene';
    this._filterAppliedBeforeProcessor = false;
    this._shaderAppliedBeforeProcessor = false;

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
        accelerated: this.sdlAccelerated,
        fullscreen: this.fullscreen,
        opengl: this.opengl,
        // Open at the presentation shape, not the pixel grid's — the exact
        // aspect (core-informed) lands via setAspectRatio once the core's AV
        // info is read, which auto-fits the window if it changed.
        aspect: this.aspectMode === 'native' ? null : this.displayAspectRatio,
      });
      this.sdlRenderer.init(this.initWidth || 256, this.initHeight || 224);
      this.sdlRenderer.getWindow()?.on('resize', (event) => {
        this.onDisplayChange?.(event.pixelWidth, event.pixelHeight);
      });

      // GL presentation rides on the SDL window. Context and preset failures
      // are both fatal and loud (see the catch below).
      if (this.shaderPreset) {
        const { GLRenderer } = await import('./GLRenderer.js');
        try {
          this.glRenderer = await GLRenderer.create({
            window: this.sdlRenderer.getWindow(),
            presetPath: this.shaderPreset,
          });
          const st = this.glRenderer.status();
          console.error(`[shader] ${this.shaderPreset} — ${st.passes} pass(es)`);
          for (const w of st.warnings) console.error(`[shader] ${w}`);
        } catch (err) {
          // No CPU fallback: --shader was asked for by name, and the machines
          // this runs on always have a GPU. A GL failure here is a broken
          // stack (or a broken preset) the user needs to see, not a picture
          // that quietly loses its shader.
          throw new Error(`--shader ${this.shaderPreset}: ${err.message}`);
        }
      }
    }
  }

  /**
   * Get one frame to the screen.
   *
   * The GPU shader chain and the CPU filter are alternatives, not a pipeline:
   * a preset already ends in its own final pass, and running a CPU scanline
   * filter over its output would be a second, conflicting effect.
   *
   * Either way this runs AFTER the frame has been handed to
   * onFrameCallback — screenshots, remote play and the overlay read that
   * buffer, and presentation must never be the thing that produces it.
   */
  _present(rgbaData, width, height) {
    if (this.glRenderer && this.frameProcessorEffectScope !== 'none'
      && !this._shaderAppliedBeforeProcessor) {
      this.glRenderer.render(rgbaData, width, height);
      return;
    }
    if (!this._filterAppliedBeforeProcessor && this.filter && this.filter !== 'none') {
      const f = applyFilter(rgbaData, width, height, this.filter, this._filterBuf);
      this._filterBuf = f.pixels;
      this.sdlRenderer.render(f.pixels, f.width, f.height);
      return;
    }
    this.sdlRenderer.render(rgbaData, width, height);
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
    // Presentation renderers letterbox to this ratio (the terminal path
    // reads displayAspectRatio directly each frame).
    this.sdlRenderer?.setAspect(this.displayAspectRatio);
    this.glRenderer?.setAspect(this.displayAspectRatio);
  }

  /**
   * Set the presentation aspect from what the core reported, filtered
   * through the user's aspect policy ('tv' | 'native' | 'core').
   * Called by LibretroHost once AV info is known.
   */
  setAspectFromCore(system, fbWidth, fbHeight, coreAspect) {
    if (system) this.system = system;
    if (this.aspectMode === 'native') {
      // Square pixels, live: a null renderer aspect tracks the framebuffer
      // ratio even when the core changes resolution mid-game (PSX mode
      // switches), where a pinned ratio would go stale.
      if (fbWidth > 0 && fbHeight > 0) this.displayAspectRatio = fbWidth / fbHeight;
      this.sdlRenderer?.setAspect(null);
      this.glRenderer?.setAspect(null);
      return;
    }
    this.setAspectRatio(displayAspectFor(
      this.aspectMode, this.system, fbWidth, fbHeight, coreAspect,
    ));
  }

  resizeWindow(width, height) {
    if (this.sdlRenderer) {
      this.sdlRenderer.resizeWindow(width, height);
    }
  }

  setContrast(value) {
    this.contrast = Math.max(0.5, Math.min(3.0, value));
  }

  /** CRT-style post-process on the SDL output: none | sharp | scanlines | crt */
  setFilter(name) {
    this.filter = isFilter(name) ? name : 'none';
    this._filterBuf = null; // size changes with the filter
    return this.filter;
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

  setFrameProcessor(processor, { effectScope = 'scene' } = {}) {
    this.frameProcessor = typeof processor === 'function' ? processor : null;
    this.frameProcessorEffectScope = ['none', 'game', 'scene', 'composite'].includes(effectScope)
      ? effectScope : 'scene';
  }

  _processFrame(rgba, width, height) {
    if (!this.frameProcessor) return { rgba, width, height };
    this._filterAppliedBeforeProcessor = false;
    this._shaderAppliedBeforeProcessor = false;
    if (this.frameProcessorEffectScope === 'none') this._filterAppliedBeforeProcessor = true;
    // A game-scoped filter or shader modifies only the core picture before the
    // bezel places it. Scene/composite effects run over the completed 16:9
    // frame below. GPU presets use the chain's offscreen target for both.
    if (this.frameProcessorEffectScope === 'game') {
      if (this.glRenderer) {
        const filtered = this.glRenderer.filterFrame(rgba, width, height);
        rgba = filtered.pixels;
        width = filtered.width;
        height = filtered.height;
        this._shaderAppliedBeforeProcessor = true;
      } else if (this.filter && this.filter !== 'none') {
        const filtered = applyFilter(rgba, width, height, this.filter, this._gameFilterBuf);
        this._gameFilterBuf = filtered.pixels;
        rgba = filtered.pixels;
        width = filtered.width;
        height = filtered.height;
        this._filterAppliedBeforeProcessor = true;
      }
    }
    let result = this.frameProcessor(rgba, width, height, this.frameCount);
    if (!result?.rgba || !result.width || !result.height) result = { rgba, width, height };

    // For an Active Bezel, scene/composite effects are part of the authored
    // final frame, not presentation-only decoration. Produce those pixels now
    // so SDL, screenshots, recordings and remote play all receive one
    // authoritative result. Ordinary non-bezel shader presentation retains
    // its existing zero-readback path because frameProcessor is null there.
    if (this.frameProcessorEffectScope === 'scene'
      || this.frameProcessorEffectScope === 'composite') {
      if (this.glRenderer) {
        const filtered = this.glRenderer.filterFrame(result.rgba, result.width, result.height);
        result = { rgba: filtered.pixels, width: filtered.width, height: filtered.height };
        this._shaderAppliedBeforeProcessor = true;
      } else if (this.filter && this.filter !== 'none') {
        const filtered = applyFilter(
          result.rgba, result.width, result.height, this.filter, this._filterBuf,
        );
        this._filterBuf = filtered.pixels;
        result = { rgba: filtered.pixels, width: filtered.width, height: filtered.height };
        this._filterAppliedBeforeProcessor = true;
      }
    }
    return result;
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
    let rgbaData = this._convertToRGBA(wasmModule, dataPtr, width, height, pitch, pixelFormat);
    ({ rgba: rgbaData, width, height } = this._processFrame(rgbaData, width, height));

    // SDL rendering (every frame for smoothness). The CRT/scanline filter
    // upscales 2x on its way to the texture; the terminal path and the frame
    // callback keep the unfiltered image (screenshots stay native-res).
    if (useSDL && this.sdlRenderer) {
      this._present(rgbaData, width, height);
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

  // Render a frame from RGBA Uint8Array (used by GL carts)
  onCartFrameRGBA(rgbaBuffer, width, height) {
    this.frameCount++;

    const useTerminal = this.mode === 'terminal' || this.mode === 'both';
    const useSDL = this.mode === 'sdl' || this.mode === 'both';

    const skipTerminalFrame = useTerminal && (this.frameCount % this.renderEveryN !== 0);
    const terminalBusy = useTerminal && (this.pendingFrame || !this.workerReady);

    if (!useSDL && (skipTerminalFrame || terminalBusy)) return;

    ({ rgba: rgbaBuffer, width, height } = this._processFrame(rgbaBuffer, width, height));

    if (useSDL && this.sdlRenderer) {
      if (this.glRenderer) this.glRenderer.render(rgbaBuffer, width, height);
      else this.sdlRenderer.renderRaw(rgbaBuffer, width, height, 'rgba32');
    }

    if (this.onFrameCallback) {
      this.onFrameCallback(rgbaBuffer, width, height);
    }

    if (useTerminal && !skipTerminalFrame && !terminalBusy) {
      const rgbaData = new Uint8ClampedArray(rgbaBuffer.buffer, rgbaBuffer.byteOffset, rgbaBuffer.byteLength);
      const termCols = process.stdout.columns || 80;
      const termRows = (process.stdout.rows || 24) - 1;

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
    }
  }

  // Render a frame from a raw XRGB8888 Uint8Array (used by wasmcart)
  onCartFrame(xrgbBuffer, width, height) {
    this.frameCount++;

    const useTerminal = this.mode === 'terminal' || this.mode === 'both';
    const useSDL = this.mode === 'sdl' || this.mode === 'both';

    const skipTerminalFrame = useTerminal && (this.frameCount % this.renderEveryN !== 0);
    const terminalBusy = useTerminal && (this.pendingFrame || !this.workerReady);

    if (!useSDL && (skipTerminalFrame || terminalBusy)) return;

    // SDL can render XRGB8888 directly as 'bgrx8888' — no pixel conversion
    // needed. The shader chain cannot take that shortcut: it uploads RGBA, so
    // when a shader is active we fall through to the conversion below.
    if (useSDL && this.sdlRenderer && !useTerminal && !this.glRenderer && !this.frameProcessor) {
      this.sdlRenderer.renderRaw(xrgbBuffer, width, height, 'argb8888');
      if (this.onFrameCallback) {
        this.onFrameCallback(xrgbBuffer, width, height);
      }
      return;
    }

    // Terminal mode needs RGBA conversion
    const totalPixels = width * height;
    const needed = totalPixels * 4;
    const rgbaData = new Uint8ClampedArray(needed);
    for (let i = 0; i < totalPixels; i++) {
      const si = i * 4;
      // XRGB8888 in memory (little-endian u32): byte0=B, byte1=G, byte2=R, byte3=X
      rgbaData[si]     = xrgbBuffer[si + 2]; // R
      rgbaData[si + 1] = xrgbBuffer[si + 1]; // G
      rgbaData[si + 2] = xrgbBuffer[si];     // B
      rgbaData[si + 3] = 255;                // A
    }

    ({ rgba: rgbaData, width, height } = this._processFrame(rgbaData, width, height));

    if (useSDL && this.sdlRenderer) {
      this._present(rgbaData, width, height);
    }

    if (this.onFrameCallback) {
      this.onFrameCallback(rgbaData, width, height);
    }

    if (useTerminal && !skipTerminalFrame && !terminalBusy) {
      const termCols = process.stdout.columns || 80;
      const termRows = (process.stdout.rows || 24) - 1;

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
      this.glRenderer?.destroy();
      this.glRenderer = null;
      this.sdlRenderer.destroy();
      this.sdlRenderer = null;
    }
  }
}
