import sdl from '@kmamal/sdl';

export class SDLRenderer {
  constructor(options = {}) {
    this.window = null;
    this.title = options.title || 'retroemu';
    this.scale = options.scale || 2;
  }

  init(width, height) {
    // Create window with specified dimensions
    // We multiply by scale for visibility on high-res screens
    this.window = sdl.video.createWindow({
      title: this.title,
      width: width * this.scale,
      height: height * this.scale,
      resizable: true,
      fullscreen: false
    });

    this.window.on('close', () => {
      this.destroy();
      process.exit(0);
    });
  }

  render(rgbaBuffer, width, height) {
    if (!this.window) return;
    
    // Convert Uint8ClampedArray to Buffer if needed
    // @kmamal/sdl expects a Buffer or TypedArray
    // The stride/pitch is width * 4 bytes (RGBA)
    const pitch = width * 4;
    
    // render(width, height, stride, format, buffer)
    this.window.render(width, height, pitch, 'rgba32', Buffer.from(rgbaBuffer));
  }

  destroy() {
    if (this.window) {
      this.window.destroy();
      this.window = null;
    }
  }
}
