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
import { evaluatorAvailable as evaluatorBuilt } from '../cheevos/rcheevos.js';

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
    // --ff-speed / --no-rewind come from the frontend's settings cascade.
    // Rewind costs a full serializeState twice a second, so honouring the
    // "off" choice is a real saving on heavy cores, not just a preference.
    this.ffSpeed = Number.isFinite(ctx.ffSpeed) ? ctx.ffSpeed : 4;
    this.rewindEnabled = ctx.rewindEnabled !== false;
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

  /**
   * What this session actually supports.
   *
   * A libretro session has the full surface. wasmcart and jsgame carts run
   * their own frame loop with no serialize/pause/memory API, so a frontend
   * needs to know that up front rather than discovering it one thrown RPC at
   * a time.
   */
  _capabilities() {
    const host = this.ctx.getHost?.() ?? null;
    return {
      pause: !!host,
      saveState: !!host,
      rewind: !!host && this.rewindEnabled,
      cheats: !!host,
      memory: !!host,
      coreOptions: !!host,
      // Achievements need BOTH a libretro host (for memory) and the evaluator
      // artifact, which is optional and may not have been built.
      achievements: !!host && evaluatorBuilt(),
      // Presentation is owned by the player process either way.
      screenshot: true,
      fullscreen: true,
      videoFilter: true,
      remotePlay: true,
    };
  }

  setOverlay(overlay) {
    this.overlay = overlay;
  }

  attachHost(host) {
    this.host = host;
    // Rewind snapshots AND achievement evaluation ride the host's frame hook.
    // Note the ordering: cheevos must run even when rewind is disabled, so the
    // rewind early-returns are scoped to their own block rather than the whole
    // hook — they used to `return` out of it entirely.
    host.onFrameHook = (frameCount) => {
      if (this.rewindEnabled
        && frameCount % REWIND_INTERVAL_FRAMES === 0
        && !host.paused && host.speed === 1) {
        const data = host.serializeState();
        if (data) this.rewind.push(data, frameCount);
      }
      if (this.cheevos) this._cheevosFrame(host);
    };
  }

  /**
   * One achievement evaluation tick.
   *
   * rcheevos peeks MANY addresses per frame — once per distinct memory
   * reference across the whole active set — so each peek must be a buffer
   * read, never an IPC round trip or a fresh slice of the core heap. System
   * RAM is snapshotted ONCE here and every peek is served from that snapshot.
   *
   * Paused and fast-forwarded frames are skipped: evaluating a paused game
   * wastes work, and RA's own rule is that fast-forward invalidates a session.
   */
  _cheevosFrame(host) {
    if (host.paused || host.speed !== 1) return;
    const ram = host.readMemory(this.cheevosRegion, 0, this.cheevosSize);
    if (!ram) return;
    const unlocked = this.cheevos.frame((addr, num) => {
      let v = 0;
      for (let i = 0; i < num; i++) v |= (ram[addr + i] ?? 0) << (8 * i);
      return v >>> 0;
    });
    for (const a of unlocked) {
      // The frontend owns awarding: it has the credentials and the API client.
      // This process only reports what the evaluator saw.
      //
      // `achievementId`, NOT `id`: the RPC envelope on this channel is
      // { id, result } | { id, error }, so ANY message carrying `id` is taken
      // for a response and dropped before the event handlers ever see it. An
      // achievement event with `id` unlocked correctly and then vanished
      // silently on the wire.
      this._send({ event: 'achievement', achievementId: a.id, title: a.title });
    }
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
          rewindEnabled: this.rewindEnabled,
          ffSpeed: this.ffSpeed,
          fullscreen: this._sdlWindow()?.fullscreen ?? false,
          // wasmcart and jsgame sessions drive their own loop, so the
          // libretro-shaped controls below don't apply to them. Saying so
          // here lets a frontend grey out what it can't use instead of
          // offering buttons that throw.
          kind: host ? 'libretro' : (this.ctx.system?.system ?? 'cart'),
          capabilities: this._capabilities(),
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

      // ── achievements ─────────────────────────────────────────────
      // The frontend fetches the definitions (it owns the RA credentials) and
      // hands them here; this process evaluates them against core memory and
      // emits an 'achievement' event when one triggers. Awarding stays with
      // the frontend, so the player process never needs an API key.
      case 'cheevosActivate': {
        const h = needHost();
        const { AchievementRuntime, evaluatorAvailable } = await import('../cheevos/rcheevos.js');
        if (!evaluatorAvailable()) {
          throw new Error('achievement evaluator not built — run scripts/build-rcheevos.sh in retroemu');
        }
        if (!this.cheevos) this.cheevos = await AchievementRuntime.create();

        // Evaluate against system RAM. Snapshot size comes from the core so a
        // peek can never run off the end of the region.
        const region = params.region ?? 2;
        const info = h.memoryInfo().find((r) => r.id === region);
        if (!info) throw new Error(`core exposes no memory region ${region}`);
        this.cheevosRegion = region;
        this.cheevosSize = info.size;

        const res = this.cheevos.activate(params.achievements ?? []);
        return { ...res, ...this.cheevos.status(), region, regionSize: info.size };
      }

      case 'cheevosStatus':
        return this.cheevos ? this.cheevos.status() : { active: 0, triggered: 0, primed: [] };

      case 'cheevosReset':
        // A loaded save state makes prior evaluation state meaningless.
        this.cheevos?.reset();
        return { ok: true };

      case 'cheevosStop': {
        this.cheevos?.dispose();
        this.cheevos = null;
        return { ok: true };
      }

      case 'remoteHost': {
        if (this.remoteHost) return this.remoteHost.status();
        const { RemoteHost } = await import('../net/RemotePlay.js');
        this.remoteHost = new RemoteHost({
          videoOutput: this.ctx.videoOutput,
          inputManager: this.ctx.inputManager,
          audioBridge: this.ctx.audioBridge,
          audio: params.audio !== false,
          guestPort: params.guestPort ?? 1,
          fps: params.fps ?? 20,
          log: (m) => this._send({ event: 'remote', line: m }),
        });
        const info = await this.remoteHost.start();
        return { ...info, ...this.remoteHost.status() };
      }

      case 'remoteStatus':
        return this.remoteHost ? this.remoteHost.status() : { hosting: false };

      case 'remoteStop': {
        await this.remoteHost?.stop();
        this.remoteHost = null;
        return { hosting: false };
      }

      case 'memoryInfo':
        return { regions: needHost().memoryInfo() };

      case 'readMemory': {
        const h = needHost();
        const region = params.region ?? 2; // system RAM
        const data = h.readMemory(region, params.offset ?? 0, params.length ?? 256);
        if (!data) throw new Error('region unavailable on this core');
        return {
          region,
          offset: params.offset ?? 0,
          length: data.length,
          dataB64: data.toString('base64'),
        };
      }

      case 'writeMemory': {
        const h = needHost();
        const bytes = params.dataB64
          ? Buffer.from(params.dataB64, 'base64')
          : Uint8Array.from(params.bytes ?? []);
        const written = h.writeMemory(params.region ?? 2, params.offset ?? 0, bytes);
        if (!written) throw new Error('write rejected (bad region or offset)');
        return { written };
      }

      case 'setCheats': {
        const h = needHost();
        const applied = h.setCheats(params.cheats ?? []);
        return { applied };
      }

      case 'listCoreOptions': {
        const h = needHost();
        const out = [];
        for (const [key, v] of h.coreVariables) {
          out.push({
            key,
            description: v.description ?? key,
            options: v.options ?? [],
            value: v.value,
          });
        }
        return { options: out };
      }

      case 'setCoreOption': {
        const h = needHost();
        const v = h.coreVariables.get(params.key);
        if (!v) throw new Error(`unknown core option: ${params.key}`);
        if (v.options?.length && !v.options.includes(params.value)) {
          throw new Error(`invalid value for ${params.key}: ${params.value}`);
        }
        v.value = params.value;
        h.variablesUpdated = true; // core re-reads on its next GET_VARIABLE
        return { key: params.key, value: params.value };
      }

      case 'setVideoFilter': {
        this.ctx.videoOutput?.setFilter?.(params.filter ?? 'none');
        return { filter: params.filter ?? 'none' };
      }

      case 'setInputMap': {
        // Live remap — takes effect on the next polled frame, no relaunch.
        this.ctx.inputManager?.setRemap(params.map ?? null);
        return { applied: !!params.map };
      }

      case 'listPads': {
        const pads = (this.ctx.inputManager?.currentGamepads ?? []).filter(Boolean);
        return {
          pads: pads.map((p, port) => ({
            port,
            id: p.id,
            key: p._native?.guid || p.guid || p.id,
            buttons: p.buttons?.length ?? 0,
            axes: p.axes?.length ?? 0,
          })),
        };
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
