// ControlChannel — the frontend-facing session API (--control flag).
//
// Transport: Node IPC (spawn retroemu with stdio [..., 'ipc']). Wire format:
//   parent → child : { id, method, params }
//   child  → parent: { id, result } | { id, error }
//   child  → parent (events): { event, ...payload }
//
// Events: 'ready' (host up: platform/core/av info), 'autosave' (final state
// blob pushed during shutdown so the frontend can persist resume data).
//
// This is the retroemu side of romdeck's GameSession contract. Libretro path
// only for now — wasmcart/jsgame sessions accept the channel but report
// stateSupported: false.
import { rgbaToPng } from './png.js';
import { RewindBuffer } from './RewindBuffer.js';

const REWIND_INTERVAL_FRAMES = 30; // one snapshot every half second at 60fps

export class ControlChannel {
  /**
   * @param {object} ctx
   * @param {() => import('../core/LibretroHost.js').LibretroHost|null} ctx.getHost
   * @param {import('../video/VideoOutput.js').VideoOutput} ctx.videoOutput
   * @param {() => Promise<void>} ctx.shutdown
   * @param {string} ctx.romPath
   * @param {{ name?: string, core?: string }|null} ctx.system
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.rewind = new RewindBuffer();
    this._lastFrame = null; // { rgba, width, height } — reference, not copy
    this._sentAutosave = false;

    if (typeof process.send !== 'function') {
      throw new Error('--control requires an IPC channel (spawn with stdio "ipc")');
    }

    process.on('message', (msg) => this._onMessage(msg));

    // Capture every presented frame (reference to the reused conversion
    // buffer — always holds the latest frame's pixels).
    const prevCallback = ctx.videoOutput.onFrameCallback;
    ctx.videoOutput.onFrameCallback = (rgba, width, height) => {
      this._lastFrame = { rgba, width, height };
      if (prevCallback) prevCallback(rgba, width, height);
    };
  }

  setOverlay(overlay) {
    this.overlay = overlay;
  }

  attachHost(host) {
    // Rewind snapshots ride the host's frame hook.
    host.onFrameHook = (frameCount) => {
      if (frameCount % REWIND_INTERVAL_FRAMES !== 0) return;
      if (host.paused || host.speed !== 1) return; // don't snapshot ff/paused
      const data = host.serializeState();
      if (data) this.rewind.push(data, frameCount);
    };
  }

  sendReady() {
    const host = this.ctx.getHost();
    this._send({
      event: 'ready',
      romPath: this.ctx.romPath,
      core: this.ctx.system?.core ?? null,
      system: this.ctx.system?.name ?? null,
      stateSupported: !!host,
      av: host?.systemAVInfo ?? null,
    });
  }

  /** Push the final state to the parent before exit (resume-on-next-launch). */
  async sendAutosave() {
    if (this._sentAutosave) return;
    this._sentAutosave = true;
    const host = this.ctx.getHost();
    if (!host) return;
    const data = host.serializeState();
    if (!data) return;
    const shot = this._screenshotPng();
    await new Promise((resolve) => {
      this._send(
        {
          event: 'autosave',
          stateB64: data.toString('base64'),
          screenshotPngB64: shot ? shot.toString('base64') : null,
          frameCount: host._frameCount,
        },
        resolve,
      );
    });
  }

  _screenshotPng() {
    // While the overlay menu is up, screenshot what the player actually sees.
    const f = (this.overlay?.open && this.overlay.lastDrawn) || this._lastFrame;
    if (!f) return null;
    try {
      return rgbaToPng(f.rgba, f.width, f.height);
    } catch {
      return null;
    }
  }

  _send(msg, cb) {
    try {
      process.send(msg, undefined, undefined, cb ? () => cb() : undefined);
    } catch {
      if (cb) cb();
    }
  }

  async _onMessage(msg) {
    if (!msg || typeof msg !== 'object' || msg.id === undefined) return;
    const { id, method, params = {} } = msg;
    try {
      const result = await this._dispatch(method, params);
      this._send({ id, result: result ?? {} });
    } catch (err) {
      this._send({ id, error: err.message });
    }
  }

  async _dispatch(method, params) {
    const host = this.ctx.getHost();
    const needHost = () => {
      if (!host) throw new Error(`${method}: no libretro host (cart/jsgame session)`);
      return host;
    };

    switch (method) {
      case 'getStatus':
        return {
          romPath: this.ctx.romPath,
          core: this.ctx.system?.core ?? null,
          system: this.ctx.system?.name ?? null,
          frameCount: host?._frameCount ?? 0,
          paused: host?.paused ?? false,
          speed: host?.speed ?? 1,
          rewindDepth: this.rewind.depth,
          fullscreen: this._sdlWindow()?.fullscreen ?? false,
        };

      case 'pause':
        needHost().pause();
        return { paused: true };

      case 'resume':
        needHost().resume();
        return { paused: false };

      case 'reset':
        needHost().reset();
        this.rewind.clear();
        return {};

      case 'saveState': {
        const h = needHost();
        const data = h.serializeState();
        if (!data) throw new Error('core does not support serialization');
        const shot = params.screenshot === false ? null : this._screenshotPng();
        return {
          stateB64: data.toString('base64'),
          screenshotPngB64: shot ? shot.toString('base64') : null,
          frameCount: h._frameCount,
          size: data.length,
        };
      }

      case 'loadState': {
        const h = needHost();
        if (!params.stateB64) throw new Error('loadState: stateB64 required');
        const ok = h.unserializeState(Buffer.from(params.stateB64, 'base64'));
        if (!ok) throw new Error('core rejected the state blob');
        this.rewind.clear();
        return {};
      }

      case 'screenshot': {
        const shot = this._screenshotPng();
        if (!shot) throw new Error('no frame captured yet');
        return {
          pngB64: shot.toString('base64'),
          width: this._lastFrame.width,
          height: this._lastFrame.height,
        };
      }

      case 'setSpeed': {
        const h = needHost();
        const x = Number(params.x);
        if (!Number.isFinite(x) || x < 0 || x > 8) {
          throw new Error('setSpeed: x must be 0 (uncapped) or 0.25-8');
        }
        h.setSpeed(x);
        return { speed: h.speed };
      }

      case 'setFullscreen': {
        const win = this._sdlWindow();
        if (!win) throw new Error('no SDL window');
        win.setFullscreen(!!params.on);
        return { fullscreen: !!params.on };
      }

      case 'rewind': {
        const h = needHost();
        const steps = Math.max(1, Math.min(60, Number(params.steps) || 1));
        const entry = this.rewind.pop(steps);
        if (!entry) throw new Error('no rewind history');
        const ok = h.unserializeState(entry.data);
        if (!ok) throw new Error('core rejected rewind state');
        return { frame: entry.frame, depth: this.rewind.depth };
      }

      case 'menu': {
        if (!this.overlay) throw new Error('no overlay (terminal video mode)');
        const op = params.op ?? 'toggle';
        if (op === 'toggle') this.overlay.toggle();
        else if (op === 'open') this.overlay.show();
        else if (op === 'close') this.overlay.close();
        else if (op === 'nav') this.overlay.key(params.action);
        else throw new Error(`menu: unknown op ${op}`);
        return { open: this.overlay.open, selected: this.overlay.selected };
      }

      case 'quit':
        // Fire shutdown on the next tick so the response reaches the parent.
        setImmediate(() => this.ctx.shutdown());
        return {};

      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  _sdlWindow() {
    try {
      return this.ctx.videoOutput.getSDLWindow();
    } catch {
      return null;
    }
  }
}
