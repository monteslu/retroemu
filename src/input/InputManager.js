import { installNavigatorShim } from 'gamepad-node';
import { appendFileSync } from 'fs';
import { LIBRETRO_TO_W3C, axisToLibretro } from './InputMap.js';
import {
  RETRO_DEVICE_JOYPAD,
  RETRO_DEVICE_ANALOG,
  RETRO_DEVICE_INDEX_ANALOG_LEFT,
  RETRO_DEVICE_INDEX_ANALOG_RIGHT,
  RETRO_DEVICE_INDEX_ANALOG_BUTTON,
  RETRO_DEVICE_ID_ANALOG_X,
  RETRO_DEVICE_ID_ANALOG_Y,
  JOYPAD_MASK,
} from '../constants/libretro.js';

export class InputManager {
  constructor(options = {}) {
    this.disableGamepad = options.disableGamepad || false;
    this.debugInput = options.debugInput || false;
    this.manager = this.disableGamepad ? null : installNavigatorShim({ sdl: options.sdl });
    this.currentGamepads = [];
    this._debugLoggedButtons = new Set(); // Avoid spam
    this._exitComboHeld = 0; // Frames Start+Select held together

    // Keyboard state for players without controllers
    // Maps button id -> frame number when last pressed
    this._keyLastPressed = new Map();
    this._currentFrame = 0;
    this._keyHoldFrames = 8; // Hold key for 8 frames (~133ms) - short to avoid stickiness
    this._sdlWindow = null;
    this._rawKeysDown = new Set(); // Raw SDL scancodes currently held
    this._rawKeysPrev = new Set(); // Previous frame's state

    // Optional frontend-supplied remap:
    //   { devices: { <guid|name>: { bindings: { <libretroId>: {type,index,dir} },
    //                              deadzone } },
    //     portOrder: [<guid|name>, ...] }
    // Absent bindings fall back to the positional W3C defaults, so a partial
    // remap only overrides what the user actually rebound.
    this.remap = options.remap ?? null;
    this._setupKeyboard();
  }

  setRemap(remap) {
    this.remap = remap ?? null;
  }

  /**
   * Remote play: a guest's controller occupies a port like any local pad.
   * Pass null to release the port (guest left → that player goes idle).
   * The emulator never learns the difference.
   */
  setRemoteInput(port, pad) {
    this._remotePads ??= new Map();
    if (pad) this._remotePads.set(port, pad);
    else this._remotePads.delete(port);
  }

  /** Stable device key: SDL GUID when available, else the pad's name. */
  static deviceKey(pad) {
    return pad?._native?.guid || pad?.guid || pad?.id || 'unknown';
  }

  /** Order pads by the frontend's player assignment (unlisted pads follow). */
  _orderPads(pads) {
    const order = this.remap?.portOrder;
    if (!order?.length) return pads;
    const byKey = new Map();
    for (const p of pads) {
      const key = InputManager.deviceKey(p);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(p);
    }
    const out = [];
    for (const key of order) {
      const list = byKey.get(key);
      if (list?.length) out.push(list.shift());
    }
    for (const list of byKey.values()) out.push(...list);
    return out;
  }

  // Register SDL window for keyboard events (when SDL video is active)
  setSDLWindow(sdlWindow) {
    if (!sdlWindow) return;
    this._sdlWindow = sdlWindow;

    // SDL key names to libretro button IDs
    const sdlKeyMap = {
      up: 4,       // JOYPAD_UP
      down: 5,     // JOYPAD_DOWN
      left: 6,     // JOYPAD_LEFT
      right: 7,    // JOYPAD_RIGHT
      z: 0,        // JOYPAD_B (action button)
      x: 8,        // JOYPAD_A
      a: 1,        // JOYPAD_Y
      s: 9,        // JOYPAD_X
      return: 3,   // JOYPAD_START
      enter: 3,    // JOYPAD_START (alternate)
      shift: 2,    // JOYPAD_SELECT
      q: 10,       // JOYPAD_L
      w: 11,       // JOYPAD_R
    };

    sdlWindow.on('keyDown', (e) => {
      const key = e.key?.toLowerCase();

      // Overlay menu (when a frontend/overlay registered a handler): the menu
      // consumes nav keys while open, and ESC opens/closes it instead of
      // hard-quitting. Without a handler, ESC quits (classic behavior).
      if (this.onMenu) {
        const overlayNav = { up: 'up', down: 'down', return: 'confirm', enter: 'confirm', z: 'confirm', x: 'back' };
        if (this.menuKeyRouter && this.menuKeyRouter(overlayNav[key] ?? key)) return;
        if (key === 'escape') {
          this.onMenu();
          return;
        }
      } else if (key === 'escape') {
        process.emit('SIGINT');
        return;
      }
      // F1 = reset, F5 = save, F7 = load
      if (key === 'f1') process.emit('emu:reset');
      if (key === 'f5') process.emit('emu:save');
      if (key === 'f7') process.emit('emu:load');

      // Map to libretro button
      const id = sdlKeyMap[key];
      if (id !== undefined) {
        this._keyLastPressed.set(id, this._currentFrame);
      }

      // Forward raw scancode for wasmcart keyboard ABI
      if (e.scancode != null) {
        this._rawKeysDown.add(e.scancode);
      }
    });

    sdlWindow.on('keyUp', (e) => {
      if (e.scancode != null) {
        this._rawKeysDown.delete(e.scancode);
      }
    });
  }

  poll() {
    this._currentFrame++;
    if (!this.disableGamepad) {
      const gamepads = navigator.getGamepads().filter((gp) => gp !== null);

      // Log gamepad info once
      if (this.debugInput && gamepads.length > 0 && !this._loggedGamepadInfo) {
        this._loggedGamepadInfo = true;
        const gp = gamepads[0];
        appendFileSync('/tmp/emu-input.log', `\n=== Gamepad: ${gp.id} ===\n`);
        appendFileSync('/tmp/emu-input.log', `Buttons: ${gp.buttons.length}, Axes: ${gp.axes.length}\n`);
        gp.buttons.forEach((btn, i) => {
          if (btn.pressed || btn.value > 0.1) {
            appendFileSync('/tmp/emu-input.log', `  btn[${i}] pressed=${btn.pressed} value=${btn.value}\n`);
          }
        });
        gp.axes.forEach((val, i) => {
          if (Math.abs(val) > 0.1) {
            appendFileSync('/tmp/emu-input.log', `  axis[${i}] = ${val}\n`);
          }
        });
      }

      this.currentGamepads = this._orderPads(gamepads);

      // Start+Select combo: with an overlay registered it opens the menu at
      // ~0.5s (and a long 2s hold still hard-quits as a safety hatch);
      // without one it quits at 0.5s (classic behavior).
      if (gamepads.length > 0) {
        const gp = gamepads[0];
        const startPressed = gp.buttons[9]?.pressed;
        const selectPressed = gp.buttons[8]?.pressed;
        if (startPressed && selectPressed) {
          this._exitComboHeld++;
          if (this.onMenu) {
            if (this._exitComboHeld === 30) this.onMenu();
            if (this._exitComboHeld >= 120) process.emit('SIGINT');
          } else if (this._exitComboHeld >= 30) {
            process.emit('SIGINT');
          }
        } else {
          this._exitComboHeld = 0;
        }
      }
    }
  }

  /*
   * The CORE-facing read: physical state with any one-frame Active Bezel
   * override applied on the joypad word. The bezel itself reads through
   * getPhysicalState below — it must see the real pad (a left/right swap
   * that read its own output would re-swap every frame), while the game
   * sees what pre_render decided.
   */
  getState(port, device, index, id) {
    if (device === RETRO_DEVICE_JOYPAD) {
      const ov = this._overrides?.[port];
      if (ov) {
        const mask = this._effectiveMask(port, ov);
        if (id === JOYPAD_MASK) return mask;
        if (id < 0 || id >= 16) return 0;
        return (mask >> id) & 1;
      }
    }
    return this.getPhysicalState(port, device, index, id);
  }

  /** What the pad is REALLY doing, overrides ignored (the bezel's view). */
  getPhysicalState(port, device, index, id) {
    // Try gamepad first, fall back to keyboard for port 0.
    // A remote guest's pad takes the port it was assigned.
    const gamepad = this._remotePads?.get(port) ?? this.currentGamepads[port];

    if (device === RETRO_DEVICE_JOYPAD) {
      // Handle bitmask query (all buttons at once)
      if (id === JOYPAD_MASK) {
        let mask = 0;
        for (let btnId = 0; btnId < 16; btnId++) {
          if (this._getButtonState(gamepad, port, btnId)) {
            mask |= (1 << btnId);
          }
        }
        return mask;
      }

      if (id < 0 || id >= 16) return 0;
      return this._getButtonState(gamepad, port, id) ? 1 : 0;
    }

    if (device === RETRO_DEVICE_ANALOG && gamepad) {
      // Trigger pressure: index BUTTON, id = the joypad id (L2/R2). W3C
      // trigger buttons carry an analog .value; scale to libretro's 0..32767.
      if (index === RETRO_DEVICE_INDEX_ANALOG_BUTTON) {
        const w3cIndex = LIBRETRO_TO_W3C[id];
        const value = (w3cIndex >= 0 && w3cIndex < gamepad.buttons.length)
          ? (gamepad.buttons[w3cIndex]?.value ?? 0)
          : 0;
        return Math.round(Math.max(0, Math.min(1, value)) * 32767);
      }
      // Analog stick input
      // index: LEFT=0, RIGHT=1
      // id: X=0, Y=1
      let axisIndex;
      if (index === RETRO_DEVICE_INDEX_ANALOG_LEFT) {
        axisIndex = id === RETRO_DEVICE_ID_ANALOG_X ? 0 : 1;
      } else if (index === RETRO_DEVICE_INDEX_ANALOG_RIGHT) {
        axisIndex = id === RETRO_DEVICE_ID_ANALOG_X ? 2 : 3;
      } else {
        return 0;
      }

      if (axisIndex < gamepad.axes.length) {
        return axisToLibretro(gamepad.axes[axisIndex]);
      }
    }

    return 0;
  }

  /*
   * One-frame input overrides (the Active Bezel pre_render path). `full`
   * replaces the whole joypad word (the id-256 form); `set`/`clear` are
   * per-button edits on top of the LIVE physical state, so overriding one
   * button leaves the rest of the pad real. Cleared before every frame by
   * the host loop; a bezel re-asserts each frame it still wants one.
   */
  setOverride(port, device, index, id, value) {
    if (device !== RETRO_DEVICE_JOYPAD) return false; // joypad only, like romdev
    if (!Number.isInteger(port) || port < 0 || port > 7) return false;
    this._overrides ??= [];
    const ov = this._overrides[port] ?? (this._overrides[port] = { full: null, set: 0, clear: 0 });
    if (id === JOYPAD_MASK) {
      ov.full = value & 0xffff;
      ov.set = 0;
      ov.clear = 0;
      return true;
    }
    if (id < 0 || id >= 16) return false;
    const bit = 1 << id;
    if (ov.full !== null) {
      ov.full = value ? (ov.full | bit) : (ov.full & ~bit);
      return true;
    }
    if (value) { ov.set |= bit; ov.clear &= ~bit; } else { ov.clear |= bit; ov.set &= ~bit; }
    return true;
  }

  clearOverrides() {
    if (this._overrides) this._overrides.length = 0;
  }

  _effectiveMask(port, ov) {
    if (ov.full !== null) return ov.full;
    const physical = this.getPhysicalState(port, RETRO_DEVICE_JOYPAD, 0, JOYPAD_MASK);
    return (physical & ~ov.clear) | ov.set;
  }

  _getButtonState(gamepad, port, id) {
    // Gamepad input
    if (gamepad) {
      // Frontend remap wins when this device has a binding for this button
      const binding = this.remap
        ? this.remap.devices?.[InputManager.deviceKey(gamepad)]?.bindings?.[id]
        : null;
      if (binding) return this._bindingActive(gamepad, binding);

      const w3cIndex = LIBRETRO_TO_W3C[id];
      if (w3cIndex >= 0 && w3cIndex < gamepad.buttons.length) {
        const btn = gamepad.buttons[w3cIndex];
        if (btn?.pressed) {
          if (this.debugInput && !this._debugLoggedButtons.has(id)) {
            appendFileSync('/tmp/emu-input.log', `Button: libretro=${id} w3c=${w3cIndex} value=${btn.value}\n`);
            this._debugLoggedButtons.add(id);
          }
          return true;
        } else {
          this._debugLoggedButtons.delete(id);
        }
      }
    }

    // Keyboard fallback for port 0
    if (port === 0) {
      const lastPressed = this._keyLastPressed.get(id);
      if (lastPressed !== undefined && (this._currentFrame - lastPressed) < this._keyHoldFrames) {
        return true;
      }
    }

    return false;
  }

  /** Is a remapped source (button or axis direction) currently active? */
  _bindingActive(gamepad, binding) {
    if (binding.type === 'button') {
      return !!gamepad.buttons?.[binding.index]?.pressed;
    }
    if (binding.type === 'axis') {
      const value = gamepad.axes?.[binding.index];
      if (value === undefined) return false;
      const dz = this.remap?.devices?.[InputManager.deviceKey(gamepad)]?.deadzone ?? 0.35;
      return binding.dir < 0 ? value < -dz : value > dz;
    }
    return false;
  }

  // Return wasmcart button bitmask from keyboard state (for port 0)
  getKeyboardButtons() {
    // Libretro button ID → wasmcart button bit
    const LIBRETRO_TO_WC = [
      /* 0  JOYPAD_B      */ 1 << 0,   // WC_BTN_A
      /* 1  JOYPAD_Y      */ 1 << 3,   // WC_BTN_Y
      /* 2  JOYPAD_SELECT */ 1 << 7,   // WC_BTN_SELECT
      /* 3  JOYPAD_START  */ 1 << 6,   // WC_BTN_START
      /* 4  JOYPAD_UP     */ 1 << 8,   // WC_BTN_UP
      /* 5  JOYPAD_DOWN   */ 1 << 9,   // WC_BTN_DOWN
      /* 6  JOYPAD_LEFT   */ 1 << 10,  // WC_BTN_LEFT
      /* 7  JOYPAD_RIGHT  */ 1 << 11,  // WC_BTN_RIGHT
      /* 8  JOYPAD_A      */ 1 << 1,   // WC_BTN_B
      /* 9  JOYPAD_X      */ 1 << 2,   // WC_BTN_X
      /* 10 JOYPAD_L      */ 1 << 4,   // WC_BTN_L
      /* 11 JOYPAD_R      */ 1 << 5,   // WC_BTN_R
    ];
    let buttons = 0;
    for (const [id, lastFrame] of this._keyLastPressed) {
      if ((this._currentFrame - lastFrame) < this._keyHoldFrames && id < LIBRETRO_TO_WC.length) {
        buttons |= LIBRETRO_TO_WC[id];
      }
    }
    return buttons;
  }

  /**
   * Forward raw keyboard state to CartHost for wasmcart keyboard ABI.
   * Call this each frame after poll().
   */
  updateCartKeyboard(cartHost) {
    if (!cartHost) return;
    // Send keyDown for newly pressed keys
    for (const sc of this._rawKeysDown) {
      if (!this._rawKeysPrev.has(sc)) {
        cartHost.keyDown(sc);
      }
    }
    // Send keyUp for released keys
    for (const sc of this._rawKeysPrev) {
      if (!this._rawKeysDown.has(sc)) {
        cartHost.keyUp(sc);
      }
    }
    // Update prev state
    this._rawKeysPrev = new Set(this._rawKeysDown);
  }

  _setupKeyboard() {
    // Default keyboard mapping for port 0 (arrow keys + Z/X/A/S + Enter/Shift)
    // Maps keyboard key names to libretro joypad IDs
    const keyMap = {
      up: 4,       // JOYPAD_UP
      down: 5,     // JOYPAD_DOWN
      left: 6,     // JOYPAD_LEFT
      right: 7,    // JOYPAD_RIGHT
      z: 0,        // JOYPAD_B (action button)
      x: 8,        // JOYPAD_A
      a: 1,        // JOYPAD_Y
      s: 9,        // JOYPAD_X
      return: 3,   // JOYPAD_START
      shift: 2,    // JOYPAD_SELECT
      q: 10,       // JOYPAD_L
      w: 11,       // JOYPAD_R
    };

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');

      process.stdin.on('data', (key) => {
        // Ctrl+C or ESC to exit
        if (key === '\u0003' || (key === '\u001b' && key.length === 1)) {
          process.emit('SIGINT');
          return;
        }

        // F1 = reset, F5 = save state, F7 = load state
        if (key === '\u001b[11~') process.emit('emu:reset');
        if (key === '\u001b[15~') process.emit('emu:save');
        if (key === '\u001b[18~') process.emit('emu:load');

        // Handle arrow keys (escape sequences)
        if (key === '\u001b[A') {
          this._pressKey('up');
        } else if (key === '\u001b[B') {
          this._pressKey('down');
        } else if (key === '\u001b[C') {
          this._pressKey('right');
        } else if (key === '\u001b[D') {
          this._pressKey('left');
        } else if (key === '\r' || key === '\n') {
          this._pressKey('return');
        } else {
          const lower = key.toLowerCase();
          if (keyMap[lower] !== undefined) {
            this._pressKey(lower);
          }
        }
      });

      // Store the key map for lookups
      this._keyMap = keyMap;
    }
  }

  _pressKey(keyName) {
    const id = this._keyMap[keyName];
    if (id === undefined) return;

    // Record the frame when this key was pressed
    // Key will be considered "held" for _keyHoldFrames frames
    this._keyLastPressed.set(id, this._currentFrame);
  }

  destroy() {
    // Clean up gamepad manager
    if (this.manager && this.manager.destroy) {
      try {
        this.manager.destroy();
      } catch {
        // Ignore cleanup errors
      }
    }

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.removeAllListeners('data');
      process.stdin.pause();
    }
  }
}
