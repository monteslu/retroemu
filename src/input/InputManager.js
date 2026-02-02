import { installNavigatorShim } from 'gamepad-node';
import { appendFileSync } from 'fs';
import { LIBRETRO_TO_W3C, axisToLibretro } from './InputMap.js';
import {
  RETRO_DEVICE_JOYPAD,
  RETRO_DEVICE_ANALOG,
  RETRO_DEVICE_INDEX_ANALOG_LEFT,
  RETRO_DEVICE_INDEX_ANALOG_RIGHT,
  RETRO_DEVICE_ID_ANALOG_X,
  RETRO_DEVICE_ID_ANALOG_Y,
  JOYPAD_MASK,
} from '../constants/libretro.js';

export class InputManager {
  constructor(options = {}) {
    this.disableGamepad = options.disableGamepad || false;
    this.debugInput = options.debugInput || false;
    this.manager = this.disableGamepad ? null : installNavigatorShim();
    this.currentGamepads = [];
    this._debugLoggedButtons = new Set(); // Avoid spam
    this._exitComboHeld = 0; // Frames Start+Select held together

    // Keyboard state for players without controllers
    // Maps button id -> frame number when last pressed
    this._keyLastPressed = new Map();
    this._currentFrame = 0;
    this._keyHoldFrames = 8; // Hold key for 8 frames (~133ms) - short to avoid stickiness
    this._setupKeyboard();
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

      this.currentGamepads = gamepads;

      // Check for Start+Select exit combo (buttons 8 and 9)
      if (gamepads.length > 0) {
        const gp = gamepads[0];
        const startPressed = gp.buttons[9]?.pressed;
        const selectPressed = gp.buttons[8]?.pressed;
        if (startPressed && selectPressed) {
          this._exitComboHeld++;
          // Exit after ~0.5 seconds (30 frames at 60fps)
          if (this._exitComboHeld >= 30) {
            process.emit('SIGINT');
          }
        } else {
          this._exitComboHeld = 0;
        }
      }
    }
  }

  getState(port, device, index, id) {
    // Try gamepad first, fall back to keyboard for port 0
    const gamepad = this.currentGamepads[port];

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

  _getButtonState(gamepad, port, id) {
    // Gamepad input
    if (gamepad) {
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
