import sdl from '@kmamal/sdl';

export class SDLRenderer {
  constructor(options = {}) {
    this.sdl = sdl;
    this.window = null;
    this.title = options.title || 'retroemu';
    this.scale = options.scale || 2;
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
    });

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
    if (!this.window || !this.initialized) return;

    // Update source dimensions if changed
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
    }

    const pitch = width * 4; // RGBA = 4 bytes per pixel
    const buffer = Buffer.from(rgbaBuffer.buffer);

    // Calculate draw rect like jsgamelauncher:
    // - windowRatio is cached (updated on resize)
    // - pixelWidth/pixelHeight read fresh from window
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

    // SDL render with dstRect for aspect ratio preservation
    this.window.render(width, height, pitch, 'rgba32', buffer, {
      scaling: 'nearest',
      dstRect: {
        x: drawX,
        y: drawY,
        width: drawWidth,
        height: drawHeight,
      },
    });
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
      this.window.destroy();
      this.window = null;
    }
    this.initialized = false;
  }
}
