// In-game overlay menu, drawn straight into the frame buffer and presented
// through the normal SDL path. Opened by Start+Select (held ~0.5s) or ESC.
// The core pauses while the menu is up; the menu repaints over a darkened
// copy of the last game frame.
//
// Actions: Resume · Save State · Load State · Screenshot · Fullscreen · Quit.
// Save/Load use SaveManager slot 0 — the same states the F5/F7 hotkeys use —
// so it behaves identically standalone and under a frontend.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { drawText, textWidth } from './font5x7.js';
import { rgbaToPng } from './png.js';

const NAV_REPEAT_MS = 160;

export class Overlay {
  constructor({
    getHost, videoOutput, inputManager, shutdown, romPath, saveDir,
    getActiveBezel = null, disableActiveBezel = null,
  }) {
    this.getHost = getHost;
    this.videoOutput = videoOutput;
    this.inputManager = inputManager;
    this.shutdownFn = shutdown;
    this.romPath = romPath;
    this.saveDir = saveDir;
    this.getActiveBezel = getActiveBezel;
    this.disableActiveBezel = disableActiveBezel;

    this.open = false;
    this.selected = 0;
    this.timer = null;
    this.message = null;
    this.messageTicks = 0;
    this._lastFrame = null; // { rgba: copy?, width, height } — reference
    this._prevButtons = new Set();
    this._navReadyAt = 0;

    // Chain onto the frame callback to keep the latest game frame.
    const prev = videoOutput.onFrameCallback;
    videoOutput.onFrameCallback = (rgba, width, height) => {
      this._lastFrame = { rgba, width, height };
      if (prev) prev(rgba, width, height);
    };

    this.items = [
      { label: 'RESUME', run: () => this.close() },
      { label: 'SAVE STATE', run: () => this._save() },
      { label: 'LOAD STATE', run: () => this._load() },
      { label: 'SCREENSHOT', run: () => this._screenshot() },
      { label: 'FULLSCREEN', run: () => this._fullscreen() },
      ...(this.getActiveBezel?.() ? [{
        label: 'DISABLE ACTIVE BEZEL',
        run: () => {
          this.disableActiveBezel?.();
          this._flash('ACTIVE BEZEL DISABLED');
        },
      }] : []),
      { label: 'QUIT', run: () => this.shutdownFn() },
    ];
  }

  toggle() {
    this.open ? this.close() : this.show();
  }

  show() {
    const host = this.getHost();
    if (this.open || !host || !this._lastFrame) return;
    this.open = true;
    this.selected = 0;
    this.message = null;
    host.pause();
    this._prevButtons = this._readButtons(); // swallow the opening press
    this.timer = setInterval(() => this._tick(), 33);
    this._draw();
  }

  close() {
    if (!this.open) return;
    this.open = false;
    clearInterval(this.timer);
    this.timer = null;
    this.getHost()?.resume();
  }

  // ── input ────────────────────────────────────────────────────────────
  _readButtons() {
    const held = new Set();
    const pads = this.inputManager.currentGamepads ?? [];
    for (const gp of pads) {
      if (!gp) continue;
      const b = gp.buttons ?? [];
      if (b[12]?.pressed || (gp.axes?.[1] ?? 0) < -0.5) held.add('up');
      if (b[13]?.pressed || (gp.axes?.[1] ?? 0) > 0.5) held.add('down');
      if (b[0]?.pressed) held.add('confirm'); // south
      if (b[1]?.pressed) held.add('back');    // east
      if (b[9]?.pressed) held.add('confirm'); // start
    }
    return held;
  }

  /** Keyboard path: called from InputManager's keyDown hook while open. */
  key(name) {
    if (!this.open) return false;
    if (name === 'up') this._move(-1);
    else if (name === 'down') this._move(1);
    else if (name === 'confirm') this.items[this.selected].run();
    else if (name === 'back') this.close();
    else return false;
    this._draw();
    return true;
  }

  _tick() {
    if (!this.open) return;
    // inputManager.poll() keeps running via the host's paused loop; we read
    // the freshest pad snapshot here.
    const held = this._readButtons();
    const now = Date.now();
    const fresh = (a) => held.has(a) && !this._prevButtons.has(a);
    const repeat = (a) => held.has(a) && now >= this._navReadyAt;

    if (fresh('up') || (repeat('up') && !fresh('down'))) {
      this._move(-1);
      this._navReadyAt = now + NAV_REPEAT_MS;
    } else if (fresh('down') || repeat('down')) {
      this._move(1);
      this._navReadyAt = now + NAV_REPEAT_MS;
    }
    if (fresh('confirm')) this.items[this.selected].run();
    if (fresh('back')) this.close();

    this._prevButtons = held;
    if (this.messageTicks > 0 && --this.messageTicks === 0) this.message = null;
    if (this.open) this._draw();
  }

  _move(d) {
    this.selected = (this.selected + d + this.items.length) % this.items.length;
  }

  // ── actions ──────────────────────────────────────────────────────────
  async _save() {
    try {
      await this.getHost().saveState(0);
      this._flash('SAVED');
    } catch (err) {
      this._flash('SAVE FAILED');
    }
  }

  async _load() {
    try {
      await this.getHost().loadState(0);
      this._flash('LOADED');
    } catch {
      this._flash('LOAD FAILED');
    }
  }

  _screenshot() {
    const f = this._lastFrame;
    if (!f) return this._flash('NO FRAME');
    try {
      const dir = path.join(this.saveDir ?? path.dirname(this.romPath), 'screenshots');
      mkdirSync(dir, { recursive: true });
      const name = path.basename(this.romPath).replace(/\.[^.]+$/, '');
      const file = path.join(dir, `${name}-${Date.now()}.png`);
      writeFileSync(file, rgbaToPng(f.rgba, f.width, f.height));
      this._flash('SCREENSHOT SAVED');
    } catch {
      this._flash('SCREENSHOT FAILED');
    }
  }

  _fullscreen() {
    try {
      const win = this.videoOutput.getSDLWindow();
      win.setFullscreen(!win.fullscreen);
      this._flash(win.fullscreen ? 'FULLSCREEN' : 'WINDOWED');
    } catch {
      this._flash('NO WINDOW');
    }
  }

  _flash(msg) {
    this.message = msg;
    this.messageTicks = 60;
  }

  // ── drawing ──────────────────────────────────────────────────────────
  _draw() {
    const f = this._lastFrame;
    if (!f) return;
    const { width: w, height: h } = f;
    // Darkened copy of the game frame as the backdrop
    const buf = Buffer.from(f.rgba.buffer ?? f.rgba, f.rgba.byteOffset ?? 0, w * h * 4).slice();
    for (let i = 0; i < buf.length; i += 4) {
      buf[i] = buf[i] >> 3;
      buf[i + 1] = buf[i + 1] >> 3;
      buf[i + 2] = buf[i + 2] >> 3;
    }

    const scale = Math.max(1, Math.floor(h / 150)); // ~2x on 240p, 3x on 480p
    const lineH = 9 * scale + 4;
    const totalH = (this.items.length + 2) * lineH;
    let y = Math.max(8, ((h - totalH) / 2) | 0);

    const cyan = [79, 209, 197];
    const white = [232, 236, 244];
    const dim = [140, 148, 167];
    const amber = [246, 173, 85];

    const center = (text, ty, color, s) =>
      drawText(buf, w, text, ((w - textWidth(text, s)) / 2) | 0, ty, color, s);

    center('ROMDECK MENU', y, cyan, scale);
    y += lineH + 4;
    for (let i = 0; i < this.items.length; i++) {
      const sel = i === this.selected;
      const label = sel ? `> ${this.items[i].label}` : this.items[i].label;
      center(label, y, sel ? white : dim, scale);
      y += lineH;
    }
    if (this.message) center(this.message, y + 4, amber, scale);

    this.lastDrawn = { rgba: buf, width: w, height: h };
    this.videoOutput.onCartFrameRGBA(buf, w, h);
  }
}
