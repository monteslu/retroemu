import sdl from '@kmamal/sdl';

export class SDLRenderer {
  constructor(options = {}) {
    this.sdl = sdl;
    this.window = null;
    this.title = options.title || 'retroemu';
    this.scale = options.scale || 2;
    this.accelerated = options.accelerated !== false; // default true
    this.fullscreen = !!options.fullscreen;
    this.opengl = !!options.opengl;
    this.width = 0;
    this.height = 0;
    this.initialized = false;
    this.windowRatio = 1;
  }

  init(width, height) {
    this.width = width;
    this.height = height;

    this.window = sdl.video.createWindow({
      title: this.title,
      width: width * this.scale,
      height: height * this.scale,
      resizable: true,
      vsync: false,
      accelerated: this.accelerated,
      fullscreen: this.fullscreen,
      opengl: this.opengl,
    });
    console.error(`[sdl] window created: vsync=${this.window.vsync} accelerated=${this.window.accelerated}`);

    this.window.on('close', () => {
      process.emit('SIGINT');
    });

    // Update cached dimensions on resize - use event values
    this.window.on('resize', (e) => {
      this.cachedWidth = e.pixelWidth;
      this.cachedHeight = e.pixelHeight;
      this.windowRatio = e.pixelWidth / e.pixelHeight;
    });

    // Initial dimensions
    this.cachedWidth = this.window.pixelWidth;
    this.cachedHeight = this.window.pixelHeight;
    this.windowRatio = this.cachedWidth / this.cachedHeight;

    this.initialized = true;
  }

  render(rgbaBuffer, width, height) {
    this._renderPixels(rgbaBuffer, width, height, 'rgba32');
  }

  // Render raw pixels with a specified SDL pixel format, avoiding extra copies
  renderRaw(buffer, width, height, format) {
    this._renderPixels(buffer, width, height, format);
  }

  _renderPixels(pixelData, width, height, format) {
    if (!this.window || !this.initialized) return;

    // Update source dimensions if changed
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
    }

    const pitch = width * 4;
    const size = width * height * 4;
    // Copy framebuffer to a standalone Buffer — avoids passing the entire
    // 805MB wasm ArrayBuffer backing store to the SDL native binding
    if (!this._fbBuf || this._fbBuf.length !== size) {
      this._fbBuf = Buffer.alloc(size);
    }
    const t0 = performance.now();
    this._fbBuf.set(pixelData);
    const buffer = this._fbBuf;

    // Calculate draw rect for aspect ratio preservation
    const canvasRatio = width / height;

    let drawX, drawY, drawWidth, drawHeight;

    if (this.windowRatio > canvasRatio) {
      // Window is wider than canvas - letterbox horizontally
      drawHeight = this.cachedHeight;
      drawWidth = Math.round(drawHeight * canvasRatio);
      drawX = Math.round((this.cachedWidth - drawWidth) / 2);
      drawY = 0;
    } else {
      // Window is taller than canvas - letterbox vertically
      drawWidth = this.cachedWidth;
      drawHeight = Math.round(drawWidth / canvasRatio);
      drawX = 0;
      drawY = Math.round((this.cachedHeight - drawHeight) / 2);
    }

    const t1 = performance.now();
    // SDL render with dstRect for aspect ratio preservation
    this.window.render(width, height, pitch, format, buffer, {
      scaling: 'nearest',
      dstRect: {
        x: drawX,
        y: drawY,
        width: drawWidth,
        height: drawHeight,
      },
    });
    const t2 = performance.now();
    const copyMs = t1 - t0;
    const renderMs = t2 - t1;
    if (copyMs + renderMs > 14) {
      console.error(`[sdl] SLOW copy=${copyMs.toFixed(1)}ms render=${renderMs.toFixed(1)}ms`);
    }
  }

  resizeWindow(width, height) {
    if (!this.window) return;
    this.window.setSize(width * this.scale, height * this.scale);
    this.width = width;
    this.height = height;
    this.cachedWidth = this.window.pixelWidth;
    this.cachedHeight = this.window.pixelHeight;
    this.windowRatio = this.cachedWidth / this.cachedHeight;
  }

  setTitle(title) {
    this.title = title;
    if (this.window) {
      this.window.setTitle(title);
    }
  }

  getWindow() {
    return this.window;
  }

  destroy() {
    if (this.window) {
      try { this.window.destroy(); } catch {}
      this.window = null;
    }
    this.initialized = false;
  }
}
