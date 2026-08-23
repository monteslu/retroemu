import sdl from '@kmamal/sdl';

export class SDLRenderer {
  constructor(options = {}) {
    this.sdl = sdl;
    this.window = null;
    this.title = options.title || 'retroemu';
    // 'auto' sizes the window to the display at first frame (and on source
    // size changes): the largest integer scale that keeps the picture inside
    // ~90% of the usable display height. A number is a fixed multiplier.
    this.scale = options.scale === 'auto' ? 'auto' : (Number(options.scale) || 2);
    this.accelerated = options.accelerated !== false; // default true
    this.fullscreen = !!options.fullscreen;
    this.opengl = !!options.opengl;
    // Presentation aspect (width/height). null = the framebuffer's own ratio
    // (square pixels). Consoles authored for a 4:3 CRT set this so the
    // picture is the shape the game was designed for, not the pixel grid's.
    this.aspect = options.aspect > 0 ? options.aspect : null;
    this.width = 0;
    this.height = 0;
    this.initialized = false;
    this.windowRatio = 1;
    this._userResized = false;
  }

  // The largest integer scale that keeps `height` source rows inside ~90%
  // of the usable display height. Computed per source height, so a mid-game
  // resolution switch (SNES hi-res interlace doubling 224 -> 448) halves the
  // scale and the window stays put instead of doubling.
  _autoScale(height) {
    if (!this._displayH) {
      let usable = 1080;
      try {
        const d = this.sdl.video.displays[0];
        usable = d?.usable?.height ?? d?.geometry?.height ?? 1080;
      } catch { /* headless or no display info; assume 1080p */ }
      this._displayH = usable;
    }
    return Math.max(1, Math.floor((this._displayH * 0.9) / Math.max(1, height)));
  }

  // The window size that presents a width x height source at this.aspect
  // with integer-ish scale: height drives, width follows the aspect.
  _idealSize(width, height) {
    const scale = this.scale === 'auto' ? this._autoScale(height) : this.scale;
    const h = Math.max(1, Math.round(height * scale));
    const ratio = this.aspect > 0 ? this.aspect : width / height;
    return { w: Math.max(1, Math.round(h * ratio)), h };
  }

  // Re-fit the window to the current source + aspect, unless the user has
  // taken over the window size (their resize wins until the next explicit
  // resizeWindow call) or we're fullscreen (size is the display's).
  // _setW/_setH are the LOGICAL size we last asked for (setSize units);
  // _autoW/_autoH are the PIXEL size that produced (resize events report
  // pixels, and on hi-dpi the two differ — comparing across units would
  // misread every programmatic resize as the user's).
  _autoFit() {
    if (!this.window || this.fullscreen || this._userResized) return;
    const { w, h } = this._idealSize(this.width, this.height);
    if (w === this._setW && h === this._setH) return;
    this._setW = w;
    this._setH = h;
    this.window.setSize(w, h);
    this._syncCachedSize();
  }

  _syncCachedSize() {
    this._autoW = this.window.pixelWidth;
    this._autoH = this.window.pixelHeight;
    this.cachedWidth = this.window.pixelWidth;
    this.cachedHeight = this.window.pixelHeight;
    this.windowRatio = this.cachedWidth / this.cachedHeight;
  }

  /**
   * Set the presentation aspect ratio (width/height; 0/null = framebuffer
   * ratio). Takes effect on the next frame; snaps the window to the new
   * shape unless the user has resized it themselves.
   */
  setAspect(ratio) {
    this.aspect = ratio > 0 ? ratio : null;
    this._autoFit();
  }

  init(width, height) {
    this.width = width;
    this.height = height;

    const mouse = sdl.mouse.position;
    const activeDisplay = sdl.video.displays.find((display) => {
      const { x, y, width: w, height: h } = display.geometry;
      return mouse.x >= x && mouse.x < x + w && mouse.y >= y && mouse.y < y + h;
    }) || sdl.video.displays[0];

    const { w: initW, h: initH } = this._idealSize(width, height);
    this._setW = initW;
    this._setH = initH;
    this.window = sdl.video.createWindow({
      title: this.title,
      // Multi-monitor desktops should open the game where the user currently
      // is, not whichever output SDL happens to enumerate first.
      display: activeDisplay,
      width: initW,
      height: initH,
      resizable: true,
      vsync: false,
      accelerated: this.accelerated,
      fullscreen: this.fullscreen,
      opengl: this.opengl,
    });
    this.window.focus();
    process.env.RETROEMU_DEBUG && console.error(`[sdl] window created: vsync=${this.window.vsync} accelerated=${this.window.accelerated}`);

    this.window.on('close', () => {
      process.emit('SIGINT');
    });

    // Update cached dimensions on resize - use event values. A resize that
    // doesn't match a size we set ourselves is the USER dragging the window:
    // from then on their size wins and auto-fit stays hands-off.
    this.window.on('resize', (e) => {
      this.cachedWidth = e.pixelWidth;
      this.cachedHeight = e.pixelHeight;
      this.windowRatio = e.pixelWidth / e.pixelHeight;
      if (e.pixelWidth !== this._autoW || e.pixelHeight !== this._autoH) {
        this._userResized = true;
      }
    });

    // Initial dimensions
    this._syncCachedSize();

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

    // Update source dimensions if changed (and re-fit the window shape —
    // a core can change resolution mid-game, e.g. SNES hi-res screens)
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this._autoFit();
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

    // Calculate draw rect for aspect ratio preservation. Present at the
    // display aspect (4:3 for TV consoles, the LCD shape for handhelds),
    // not the framebuffer's pixel-grid ratio.
    const canvasRatio = this.aspect > 0 ? this.aspect : width / height;

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
      process.env.RETROEMU_DEBUG && console.error(`[sdl] SLOW copy=${copyMs.toFixed(1)}ms render=${renderMs.toFixed(1)}ms`);
    }
  }

  resizeWindow(width, height) {
    if (!this.window) return;
    this.width = width;
    this.height = height;
    // An explicit resize is a new baseline: auto-fit owns the window again.
    this._userResized = false;
    const { w, h } = this._idealSize(width, height);
    this._setW = w;
    this._setH = h;
    this.window.setSize(w, h);
    this._syncCachedSize();
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
