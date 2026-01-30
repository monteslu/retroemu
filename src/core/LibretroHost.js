import fs from 'fs/promises';
import path from 'path';
import { loadCore } from './CoreLoader.js';
import { detectSystem } from './SystemDetector.js';
import {
  RETRO_PIXEL_FORMAT_0RGB1555,
  RETRO_PIXEL_FORMAT_XRGB8888,
  RETRO_PIXEL_FORMAT_RGB565,
  RETRO_ENVIRONMENT_GET_CAN_DUPE,
  RETRO_ENVIRONMENT_SET_MESSAGE,
  RETRO_ENVIRONMENT_SET_PIXEL_FORMAT,
  RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY,
  RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY,
  RETRO_ENVIRONMENT_GET_LOG_INTERFACE,
  RETRO_ENVIRONMENT_GET_VARIABLE,
  RETRO_ENVIRONMENT_SET_VARIABLES,
  RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE,
  RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS,
  RETRO_ENVIRONMENT_SET_CONTROLLER_INFO,
  RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME,
  RETRO_ENVIRONMENT_SET_MEMORY_MAPS,
  RETRO_ENVIRONMENT_SET_SUBSYSTEM_INFO,
  RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL,
  RETRO_ENVIRONMENT_GET_RUMBLE_INTERFACE,
  RETRO_ENVIRONMENT_GET_INPUT_DEVICE_CAPABILITIES,
  RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION,
  RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2,
  RETRO_ENVIRONMENT_GET_INPUT_BITMASKS,
  RETRO_ENVIRONMENT_GET_LANGUAGE,
  RETRO_ENVIRONMENT_GET_USERNAME,
  RETRO_ENVIRONMENT_SET_SUPPORT_ACHIEVEMENTS,
  RETRO_ENVIRONMENT_GET_VFS_INTERFACE,
  RETRO_ENVIRONMENT_GET_AUDIO_VIDEO_ENABLE,
  RETRO_ENVIRONMENT_SET_SERIALIZATION_QUIRKS,
  RETRO_ENVIRONMENT_SET_CORE_OPTIONS_UPDATE_DISPLAY_CALLBACK,
  RETRO_ENVIRONMENT_SET_GEOMETRY,
  RETRO_ENVIRONMENT_SET_ROTATION,
  RETRO_ENVIRONMENT_GET_OVERSCAN,
  RETRO_ENVIRONMENT_SHUTDOWN,
  RETRO_DEVICE_JOYPAD,
} from '../constants/libretro.js';

export class LibretroHost {
  constructor({ videoOutput, audioBridge, inputManager, saveManager }) {
    this.videoOutput = videoOutput;
    this.audioBridge = audioBridge;
    this.inputManager = inputManager;
    this.saveManager = saveManager;
    this.core = null;
    this.coreName = null;
    this.pixelFormat = RETRO_PIXEL_FORMAT_0RGB1555;
    this.systemAVInfo = null;
    this.running = false;
    this.romPath = null;

    // Core variables (configuration)
    this.coreVariables = new Map();
    this.variablesUpdated = false;

    // String pointers allocated in WASM memory (for environment callbacks)
    this._allocatedStrings = [];

    // Directories
    this.systemDir = '';
    this.saveDir = '';

    // Frame counter
    this._frameCount = 0;
  }

  async loadAndStart(romPath, { systemDir, saveDir, romData } = {}) {
    this.romPath = path.resolve(romPath);
    this.systemDir = systemDir || path.dirname(this.romPath);
    this.saveDir = saveDir || path.dirname(this.romPath);

    // Ensure save dir exists
    await fs.mkdir(this.saveDir, { recursive: true });

    // Detect system from ROM extension
    const system = detectSystem(this.romPath);
    if (!system) {
      throw new Error(`Unsupported ROM file: ${path.extname(this.romPath)}`);
    }
    this.coreName = system.core;

    console.log(`System: ${system.systemName}`);
    console.log(`Core: ${system.core}`);
    console.log(`Loading...`);

    // Load the WASM core
    this.core = await loadCore(system.core);

    // Register all libretro callbacks
    this._registerCallbacks();

    // Initialize the core
    this.core._retro_init();

    // Load the ROM (use provided data or read from file)
    if (!romData) {
      romData = await fs.readFile(this.romPath);
    }
    const loaded = this._loadGame(romData);
    if (!loaded) {
      throw new Error('Core failed to load ROM');
    }

    // Read AV info (screen dimensions, FPS, audio sample rate)
    this.systemAVInfo = this._getSystemAVInfo();
    const { geometry, timing } = this.systemAVInfo;
    console.log(
      `Video: ${geometry.baseWidth}x${geometry.baseHeight} @ ${timing.fps.toFixed(2)}fps (aspect: ${geometry.aspectRatio.toFixed(3)})`
    );
    console.log(`Audio: ${timing.sampleRate}Hz`);

    // Set display aspect ratio for correct rendering
    this.videoOutput.setAspectRatio(geometry.aspectRatio);

    // Initialize audio with the core's sample rate
    await this.audioBridge.init(timing.sampleRate);

    // Load SRAM if available
    if (this.saveManager) {
      // Debug: check SRAM availability and content after game load
      const RETRO_MEMORY_SAVE_RAM = 0;
      const sramPtr = this.core._retro_get_memory_data(RETRO_MEMORY_SAVE_RAM);
      const sramSize = this.core._retro_get_memory_size(RETRO_MEMORY_SAVE_RAM);

      // Log to file since terminal uses alternate buffer
      const debugInfo = [];
      debugInfo.push(`SRAM after load: ptr=${sramPtr}, size=${sramSize}`);
      if (sramPtr && sramSize) {
        const sample = [];
        for (let i = 0; i < Math.min(32, sramSize); i++) {
          sample.push(this.core.HEAPU8[sramPtr + i]);
        }
        debugInfo.push(`SRAM content before init: ${sample.map(b => b.toString(16).padStart(2, '0')).join(' ')}`);

        // Check SRAM at various offsets to find where actual data might be
        debugInfo.push(`Checking SRAM buffer at various offsets:`)
        for (let offset = 0; offset < Math.min(sramSize, 0x8000); offset += 0x1000) {
          const sample = [];
          for (let i = 0; i < 16; i++) {
            sample.push(this.core.HEAPU8[sramPtr + offset + i]);
          }
          debugInfo.push(`  +0x${offset.toString(16)}: ${sample.map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
        }
      }
      await fs.appendFile('/tmp/sram-debug.log', debugInfo.join('\n') + '\n');

      await this.saveManager.loadSRAM(this.core, this.romPath);
    }

    // Set controller port
    this.core._retro_set_controller_port_device(0, RETRO_DEVICE_JOYPAD);

    // Start the emulation loop
    this.running = true;
    this._runLoop();
  }

  stop() {
    this.running = false;
  }

  async shutdown() {
    this.stop();

    // Save SRAM
    if (this.saveManager && this.core) {
      await this.saveManager.saveSRAM(this.core, this.romPath);
    }

    if (this.core) {
      this.core._retro_unload_game();
      this.core._retro_deinit();

      // Free allocated strings
      for (const ptr of this._allocatedStrings) {
        this.core._free(ptr);
      }
      this._allocatedStrings = [];
    }

    this.audioBridge.destroy();
  }

  async saveState(slot = 0) {
    if (this.saveManager && this.core) {
      await this.saveManager.saveState(this.core, this.romPath, slot);
    }
  }

  async loadState(slot = 0) {
    if (this.saveManager && this.core) {
      await this.saveManager.loadState(this.core, this.romPath, slot);
    }
  }

  reset() {
    if (this.core) {
      this.core._retro_reset();
    }
  }

  // --- Private methods ---

  _registerCallbacks() {
    const mod = this.core;

    // Environment callback: "iii" → (unsigned cmd, void* data) → bool
    const envCb = mod.addFunction((cmd, dataPtr) => {
      return this._handleEnvironment(cmd, dataPtr) ? 1 : 0;
    }, 'iii');
    mod._retro_set_environment(envCb);

    // Video refresh: "viiii" → (const void* data, unsigned width, unsigned height, size_t pitch)
    const videoCb = mod.addFunction((dataPtr, width, height, pitch) => {
      if (dataPtr === 0) return; // NULL = duplicate frame
      this.videoOutput.onFrame(mod, dataPtr, width, height, pitch, this.pixelFormat);
    }, 'viiii');
    mod._retro_set_video_refresh(videoCb);

    // Audio sample batch: "iii" → (const int16_t* data, size_t frames) → size_t
    const audioBatchCb = mod.addFunction((dataPtr, frames) => {
      return this.audioBridge.onAudioBatch(mod, dataPtr, frames);
    }, 'iii');
    mod._retro_set_audio_sample_batch(audioBatchCb);

    // Audio single sample: "vii" → (int16_t left, int16_t right)
    const audioSampleCb = mod.addFunction((left, right) => {
      this.audioBridge.onAudioSample(left, right);
    }, 'vii');
    mod._retro_set_audio_sample(audioSampleCb);

    // Input poll: "v" → ()
    const inputPollCb = mod.addFunction(() => {
      this.inputManager.poll();
    }, 'v');
    mod._retro_set_input_poll(inputPollCb);

    // Input state: "iiiii" → (unsigned port, unsigned device, unsigned index, unsigned id) → int16_t
    const inputStateCb = mod.addFunction((port, device, index, id) => {
      return this.inputManager.getState(port, device, index, id);
    }, 'iiiii');
    mod._retro_set_input_state(inputStateCb);
  }

  _handleEnvironment(cmd, dataPtr) {
    const mod = this.core;

    // Mask out RETRO_ENVIRONMENT_EXPERIMENTAL flag (0x10000)
    const RETRO_ENVIRONMENT_EXPERIMENTAL = 0x10000;
    const baseCmd = cmd & ~RETRO_ENVIRONMENT_EXPERIMENTAL;

    switch (baseCmd) {
      case RETRO_ENVIRONMENT_GET_CAN_DUPE:
        // We support frame duplication (NULL video frame)
        mod.setValue(dataPtr, 1, 'i8');
        return true;

      case RETRO_ENVIRONMENT_SET_MESSAGE:
        // Core wants to display a message - accept but we can't display it in terminal easily
        return true;

      case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT: {
        const format = mod.getValue(dataPtr, 'i32');
        if (
          format === RETRO_PIXEL_FORMAT_0RGB1555 ||
          format === RETRO_PIXEL_FORMAT_XRGB8888 ||
          format === RETRO_PIXEL_FORMAT_RGB565
        ) {
          this.pixelFormat = format;
          return true;
        }
        return false;
      }

      case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY: {
        const strPtr = this._allocString(this.systemDir);
        mod.setValue(dataPtr, strPtr, 'i32');
        return true;
      }

      case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY: {
        const strPtr = this._allocString(this.saveDir);
        mod.setValue(dataPtr, strPtr, 'i32');
        return true;
      }

      case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
        // Log callback is variadic (like printf) which can't be properly handled
        // with addFunction's fixed signatures. Return false - cores handle this
        // gracefully by not logging.
        return false;

      case RETRO_ENVIRONMENT_SET_VARIABLES: {
        // Core declares its configuration variables
        // struct retro_variable { const char *key; const char *value; }
        // Array terminated by {NULL, NULL}
        let ptr = dataPtr;
        while (true) {
          const keyPtr = mod.getValue(ptr, 'i32');
          const valPtr = mod.getValue(ptr + 4, 'i32');
          if (keyPtr === 0) break;
          const key = mod.UTF8ToString(keyPtr);
          const desc = mod.UTF8ToString(valPtr);
          // Parse "Description; option1|option2|option3" format
          const semiIdx = desc.indexOf('; ');
          if (semiIdx >= 0) {
            const options = desc.substring(semiIdx + 2).split('|');
            this.coreVariables.set(key, {
              description: desc.substring(0, semiIdx),
              options,
              value: options[0], // default to first option
            });
          }
          ptr += 8;
        }
        return true;
      }

      case RETRO_ENVIRONMENT_GET_VARIABLE: {
        // struct retro_variable { const char *key; const char *value; }
        const keyPtr = mod.getValue(dataPtr, 'i32');
        if (keyPtr === 0) return false;
        const key = mod.UTF8ToString(keyPtr);
        const variable = this.coreVariables.get(key);
        if (!variable) {
          mod.setValue(dataPtr + 4, 0, 'i32');
          return false;
        }
        const valuePtr = this._allocString(variable.value);
        mod.setValue(dataPtr + 4, valuePtr, 'i32');
        return true;
      }

      case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
        mod.setValue(dataPtr, this.variablesUpdated ? 1 : 0, 'i8');
        this.variablesUpdated = false;
        return true;

      case RETRO_ENVIRONMENT_GET_OVERSCAN:
        // No overscan cropping
        mod.setValue(dataPtr, 0, 'i8');
        return true;

      case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
      case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
      case RETRO_ENVIRONMENT_SET_SUBSYSTEM_INFO:
      case RETRO_ENVIRONMENT_SET_MEMORY_MAPS:
      case RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME:
      case RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL:
      case RETRO_ENVIRONMENT_SET_GEOMETRY:
      case RETRO_ENVIRONMENT_SET_ROTATION:
      case RETRO_ENVIRONMENT_SET_SUPPORT_ACHIEVEMENTS:
        // Accept but ignore these
        return true;

      case RETRO_ENVIRONMENT_GET_RUMBLE_INTERFACE:
        // TODO: wire up rumble via gamepad-node
        return false;

      case RETRO_ENVIRONMENT_GET_INPUT_DEVICE_CAPABILITIES: {
        // Report joypad support: bit 1 = RETRO_DEVICE_JOYPAD
        mod.setValue(dataPtr, (1 << RETRO_DEVICE_JOYPAD), 'i32');
        return true;
      }

      case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS:
        return true;

      case RETRO_ENVIRONMENT_GET_AUDIO_VIDEO_ENABLE: {
        // Bit 0: Enable audio, Bit 1: Enable video, Bit 2: Fast savestates
        // Return all enabled (0b111 = 7)
        mod.setValue(dataPtr, 7, 'i32');
        return true;
      }

      case RETRO_ENVIRONMENT_GET_VFS_INTERFACE:
        // We don't support VFS - core should fall back to standard file I/O
        return false;

      case RETRO_ENVIRONMENT_SET_SERIALIZATION_QUIRKS:
      case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_UPDATE_DISPLAY_CALLBACK:
        // Accept but ignore these
        return true;

      case RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION:
        // We support version 0 (basic variables) only
        mod.setValue(dataPtr, 0, 'i32');
        return true;

      case RETRO_ENVIRONMENT_GET_LANGUAGE:
        // RETRO_LANGUAGE_ENGLISH = 0
        mod.setValue(dataPtr, 0, 'i32');
        return true;

      case RETRO_ENVIRONMENT_GET_USERNAME: {
        const strPtr = this._allocString('player');
        mod.setValue(dataPtr, strPtr, 'i32');
        return true;
      }

      case RETRO_ENVIRONMENT_SHUTDOWN:
        this.stop();
        return true;

      default:
        // Log unhandled environment calls to a file for debugging (only unique ones)
        if (!this._loggedEnvCalls) this._loggedEnvCalls = new Set();
        if (!this._loggedEnvCalls.has(baseCmd)) {
          this._loggedEnvCalls.add(baseCmd);
          fs.appendFile('/tmp/emu-env.log', `Unhandled env call: ${baseCmd} (raw: ${cmd})\n`).catch(() => {});
        }
        return false;
    }
  }

  _loadGame(romData) {
    const mod = this.core;

    // Write ROM to Emscripten virtual filesystem for cores that need full path access
    const vfsPath = '/rom' + path.extname(this.romPath);
    if (mod.FS) {
      mod.FS.writeFile(vfsPath, romData);
    }

    // Allocate ROM data in WASM heap
    const romPtr = mod._malloc(romData.length);
    mod.HEAPU8.set(romData, romPtr);

    // Use virtual filesystem path for cores that need it
    const gamePath = mod.FS ? vfsPath : this.romPath;
    const pathPtr = this._allocString(gamePath);

    // Build retro_game_info struct:
    // { const char *path (i32), const void *data (i32), size_t size (i32), const char *meta (i32) }
    // Total: 16 bytes
    const gameInfoPtr = mod._malloc(16);
    mod.setValue(gameInfoPtr, pathPtr, 'i32');        // path
    mod.setValue(gameInfoPtr + 4, romPtr, 'i32');     // data
    mod.setValue(gameInfoPtr + 8, romData.length, 'i32'); // size
    mod.setValue(gameInfoPtr + 12, 0, 'i32');         // meta (NULL)

    const result = mod._retro_load_game(gameInfoPtr);

    // Free the game_info struct (ROM data stays allocated — core references it)
    mod._free(gameInfoPtr);

    return result !== 0;
  }

  _getSystemAVInfo() {
    const mod = this.core;

    // struct retro_system_av_info {
    //   struct retro_game_geometry {
    //     unsigned base_width;    // +0
    //     unsigned base_height;   // +4
    //     unsigned max_width;     // +8
    //     unsigned max_height;    // +12
    //     float aspect_ratio;     // +16
    //   };                        // 20 bytes
    //   struct retro_system_timing {
    //     double fps;             // +20 (8 bytes, aligned)
    //     double sample_rate;     // +28 (8 bytes)
    //   };
    // };
    // Total: 36 bytes (but alignment may add padding)
    // With alignment: geometry is 20 bytes, but timing starts at offset 24 (8-byte aligned for double)

    const avInfoPtr = mod._malloc(48); // extra space for alignment
    mod._retro_get_system_av_info(avInfoPtr);

    const baseWidth = mod.getValue(avInfoPtr, 'i32');
    const baseHeight = mod.getValue(avInfoPtr + 4, 'i32');
    const maxWidth = mod.getValue(avInfoPtr + 8, 'i32');
    const maxHeight = mod.getValue(avInfoPtr + 12, 'i32');
    const aspectRatio = mod.getValue(avInfoPtr + 16, 'float');

    // Timing struct is 8-byte aligned after geometry
    // geometry = 20 bytes → next 8-byte boundary = 24
    const timingOffset = 24;
    const fps = mod.getValue(avInfoPtr + timingOffset, 'double');
    const sampleRate = mod.getValue(avInfoPtr + timingOffset + 8, 'double');

    mod._free(avInfoPtr);

    return {
      geometry: {
        baseWidth,
        baseHeight,
        maxWidth,
        maxHeight,
        aspectRatio: aspectRatio > 0 ? aspectRatio : 4 / 3, // Default to 4:3 for retro consoles
      },
      timing: {
        fps,
        sampleRate,
      },
    };
  }

  _runLoop() {
    const fps = this.systemAVInfo.timing.fps;
    const frameDurationMs = 1000 / fps;
    let lastFrameTime = performance.now();

    const tick = () => {
      if (!this.running) return;

      const now = performance.now();
      const elapsed = now - lastFrameTime;

      if (elapsed >= frameDurationMs) {
        lastFrameTime = now - (elapsed % frameDurationMs);
        this.core._retro_run();
        this._frameCount++;
      }

      // Frame pacing: use setTimeout for coarse timing, setImmediate for tight timing
      const remaining = frameDurationMs - (performance.now() - lastFrameTime);
      if (remaining > 2) {
        setTimeout(tick, Math.floor(remaining) - 1);
      } else {
        setImmediate(tick);
      }
    };

    tick();
  }

  _allocString(str) {
    const mod = this.core;
    const len = mod.lengthBytesUTF8(str) + 1;
    const ptr = mod._malloc(len);
    mod.stringToUTF8(str, ptr, len);
    this._allocatedStrings.push(ptr);
    return ptr;
  }
}
