# retroemu

Terminal-based retro game emulator. Play classic console games directly in your terminal using libretro WASM cores.

- **25+ retro systems** — NES, SNES, Game Boy, Genesis, Atari, and more
- **Truecolor ANSI rendering** — half-block characters for clean pixel art
- **2100+ controllers supported** — via SDL2 with automatic mapping
- **Low-latency audio** — direct SDL2 audio output
- **Save states & battery saves** — automatic SRAM persistence

```
retroemu game.nes
```

## Supported Systems

The emulator auto-detects systems by file extension. All cores are from the [libretro](https://www.libretro.com/) project, compiled to WebAssembly.

### Nintendo

| System | ROM Extensions | Core |
|--------|----------------|------|
| NES / Famicom | `.nes` `.fds` `.unf` `.unif` | [fceumm](https://github.com/libretro/libretro-fceumm) |
| Super Nintendo | `.sfc` `.smc` | [snes9x](https://github.com/libretro/snes9x) |
| Game Boy | `.gb` | [gambatte](https://github.com/libretro/gambatte-libretro) |
| Game Boy Color | `.gbc` | [gambatte](https://github.com/libretro/gambatte-libretro) |
| Game Boy Advance | `.gba` | [mgba](https://github.com/libretro/mgba) |

### Sega

| System | ROM Extensions | Core |
|--------|----------------|------|
| Genesis / Mega Drive | `.md` `.gen` `.smd` `.bin` | [genesis_plus_gx](https://github.com/libretro/Genesis-Plus-GX) |
| Master System | `.sms` | [genesis_plus_gx](https://github.com/libretro/Genesis-Plus-GX) |
| Game Gear | `.gg` | [genesis_plus_gx](https://github.com/libretro/Genesis-Plus-GX) |
| SG-1000 | `.sg` | [genesis_plus_gx](https://github.com/libretro/Genesis-Plus-GX) |

### Atari

| System | ROM Extensions | Core |
|--------|----------------|------|
| Atari 2600 | `.a26` | [stella2014](https://github.com/libretro/stella2014-libretro) |
| Atari 5200 | `.a52` | [atari800](https://github.com/libretro/libretro-atari800) |
| Atari 7800 | `.a78` | [prosystem](https://github.com/libretro/prosystem-libretro) |
| Atari 800/XL/XE | `.xex` `.atr` `.atx` `.bas` `.car` `.xfd` | [atari800](https://github.com/libretro/libretro-atari800) |
| Atari Lynx | `.lnx` `.o` | [handy](https://github.com/libretro/libretro-handy) |

### NEC

| System | ROM Extensions | Core |
|--------|----------------|------|
| TurboGrafx-16 / PC Engine | `.pce` `.cue` `.ccd` `.chd` | [beetle_pce_fast](https://github.com/libretro/beetle-pce-fast-libretro) |

### SNK

| System | ROM Extensions | Core |
|--------|----------------|------|
| Neo Geo Pocket | `.ngp` | [mednafen_ngp](https://github.com/libretro/beetle-ngp-libretro) |
| Neo Geo Pocket Color | `.ngc` | [mednafen_ngp](https://github.com/libretro/beetle-ngp-libretro) |

### Bandai

| System | ROM Extensions | Core |
|--------|----------------|------|
| WonderSwan | `.ws` | [mednafen_wswan](https://github.com/libretro/beetle-wswan-libretro) |
| WonderSwan Color | `.wsc` | [mednafen_wswan](https://github.com/libretro/beetle-wswan-libretro) |

### Other Consoles

| System | ROM Extensions | Core |
|--------|----------------|------|
| ColecoVision | `.col` | [gearcoleco](https://github.com/drhelius/Gearcoleco) |
| Vectrex | `.vec` | [vecx](https://github.com/libretro/libretro-vecx) |

### Home Computers

| System | ROM Extensions | Core |
|--------|----------------|------|
| ZX Spectrum | `.tzx` `.z80` `.sna` | [fuse](https://github.com/libretro/fuse-libretro) |
| MSX / MSX2 | `.mx1` `.mx2` `.rom` `.dsk` `.cas` | [fmsx](https://github.com/libretro/fmsx-libretro) |

Just run `retroemu <rom-file>` and the correct core loads automatically based on the file extension.

**ZIP support:** ROMs can be provided inside `.zip` archives — the emulator will automatically extract and load the first supported ROM file found.

## How It Works

The emulator loads libretro cores compiled to WebAssembly via Emscripten. Each frame, the WASM core executes one tick of the emulated CPU, then calls back into JavaScript with:

- **Video**: A raw pixel framebuffer (RGB565, XRGB8888, or 0RGB1555) that gets converted to RGBA and rendered to the terminal as truecolor ANSI art via [chafa-wasm](https://github.com/nicholasgasior/chafa-wasm) in a worker thread
- **Audio**: Interleaved int16 stereo samples sent directly to SDL2 audio device (via [@kmamal/sdl](https://github.com/kmamal/node-sdl))
- **Input**: Polled from physical gamepads through the W3C Gamepad API (via [gamepad-node](../gamepad-node/)), with keyboard fallback

```
 retroemu <rom>
   │
   LibretroHost  ── loads WASM core, registers callbacks, drives retro_run() at 60fps
   │
   core._retro_run()
     │
     ├── input_poll    ──► InputManager.poll() ──► navigator.getGamepads()
     ├── input_state   ──► InputManager.getState(port, device, index, id)
     ├── [emulate one frame]
     ├── video_refresh ──► VideoOutput ──► worker thread ──► chafa-wasm ──► terminal
     └── audio_batch   ──► AudioBridge ──► SDL2 ──► speakers
```

## Prerequisites

- **Node.js** >= 22.0.0 (for ES modules and worker threads)
- **Emscripten SDK** (only needed for building cores from source)
- **A truecolor terminal** (iTerm2, Kitty, Alacritty, Windows Terminal, GNOME Terminal, etc.)

## Installation

```bash
npm install -g retroemu
```

## Building Cores

Cores must be compiled from C/C++ source to WASM using Emscripten.

Build all cores:

```bash
npm run build:cores
```

Build a single core (e.g., NES):

```bash
bash scripts/cores/fceumm.sh
```

The build script clones the libretro core repo, compiles it with `emmake`, and links it into a WASM module with the correct exported functions. Output goes to `cores/{name}_libretro.js` + `.wasm`.

### Emscripten Setup

If you don't have Emscripten installed:

```bash
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
./emsdk install latest
./emsdk activate latest
source ./emsdk_env.sh
```

## Usage

```
retroemu [options] <rom-file>

Options:
  --save-dir <dir>     Directory for save files (default: <rom-dir>/saves)
  --frame-skip <n>     Render every Nth frame to terminal (default: 2)
  --contrast <n>       Contrast boost, 1.0=normal, 1.5+=enhanced (default: 1.0)

Graphics options:
  --symbols <type>     Symbol set to use for rendering:
                       block (default), half, ascii, solid, stipple,
                       quad, sextant, octant, braille
  --colors <mode>      Color mode: true (default), 256, 16, 2
  --fg-only            Foreground color only (black background)
  --dither             Enable Floyd-Steinberg dithering

Other:
  --no-gamepad         Disable gamepad input (keyboard only)
  -h, --help           Show help
```

Examples:

```bash
retroemu ~/roms/my_game.nes
retroemu ~/roms/my_game.zip            # extracts ROM from ZIP automatically
retroemu --frame-skip 3 ~/roms/my_game.sfc
retroemu --save-dir ~/.emu/saves ~/roms/my_game.gbc
retroemu --contrast 1.5 ~/roms/my_game.a26             # boost contrast for dark games
retroemu --symbols braille --colors 2 ~/roms/my_game.gb   # monochrome braille
retroemu --symbols ascii --fg-only ~/roms/my_game.nes     # ASCII on black background
```

## Rendering

The emulator uses [@monteslu/chafa-wasm](https://github.com/monteslu/chafa-wasm) (SIMD-optimized fork) to convert pixel data to ANSI sequences.

### Symbol Sets (`--symbols`)

| Symbol Set | Description | Characters |
|------------|-------------|------------|
| `block` (default) | Full block characters | ▀ ▄ █ ░ ▒ ▓ |
| `half` | Vertical half blocks only | ▀ ▄ |
| `ascii` | ASCII printable characters | @ # % & * |
| `solid` | Space + background color only | (chunky but fast) |
| `stipple` | Shading characters | ░ ▒ ▓ |
| `quad` | 2x2 quadrant blocks | ▖ ▗ ▘ ▝ ▚ ▞ █ |
| `sextant` | 2x3 sextant blocks | 🬀🬁🬂... (highest resolution) |
| `octant` | 2x4 octant blocks | 🮖🮗... |
| `braille` | Braille dot patterns | ⠿ ⡿ ⣿ (great for B&W) |

### Color Modes (`--colors`)

| Mode | Colors | Best For |
|------|--------|----------|
| `true` (default) | 16 million | Modern terminals |
| `256` | 256 indexed | Older terminals, lower bandwidth |
| `16` | 16 ANSI | Very old terminals |
| `2` | 2 (B&W) | Monochrome display, braille |

### Additional Options

- **`--fg-only`** — Foreground color only with black background. Reduces visual noise and can improve contrast.
- **`--dither`** — Floyd-Steinberg dithering. Best combined with limited color modes (256, 16, 2).
- **`--contrast`** — Some games (especially Atari) have low contrast. Use `--contrast 1.5` or higher to boost visibility.

## Controls

### Gamepad

Any gamepad recognized by [gamepad-node](../gamepad-node/) works automatically. Buttons are mapped positionally — the south face button is always B, east is A, etc. — regardless of the controller's printed labels.

| Gamepad Button | Libretro |
|---------------|----------|
| South face (A/Cross) | B |
| East face (B/Circle) | A |
| West face (X/Square) | Y |
| North face (Y/Triangle) | X |
| L1 / LB | L |
| R1 / RB | R |
| L2 / LT | L2 |
| R2 / RT | R2 |
| Select / Back | Select |
| Start / Options | Start |
| D-Pad | D-Pad |
| Left Stick | Analog Left |
| Right Stick | Analog Right |

### Keyboard

Keyboard input is available as a fallback for player 1:

| Key | Action |
|-----|--------|
| Arrow keys | D-Pad |
| Z | B |
| X | A |
| A | Y |
| S | X |
| Q | L |
| W | R |
| Enter | Start |
| Shift | Select |

### Hotkeys

| Key | Action |
|-----|--------|
| F1 | Reset |
| F5 | Save state (slot 0) |
| F7 | Load state (slot 0) |
| ESC | Quit |
| Ctrl+C | Force quit |

## Save System

**SRAM** (battery-backed saves) is automatically saved when you quit and loaded when you start a ROM. Save files are stored as `{rom-name}.srm` in the save directory.

**Save states** capture the full emulation state (CPU registers, memory, video state, etc.) and are stored as `{rom-name}.state0`. Use F5 to save and F7 to load.

Default save directory: `saves/` next to the ROM file, configurable with `--save-dir`.

## Architecture

```
retroemu/
  bin/cli.js                    CLI entry point
  index.js                      Library exports
  src/
    core/
      LibretroHost.js           Main engine: WASM loading, callback registration, frame loop
      CoreLoader.js             Dynamic import of Emscripten WASM modules
      SystemDetector.js         ROM extension -> system/core mapping
      SaveManager.js            SRAM and save state persistence
    video/
      VideoOutput.js            Pixel format conversion, aspect ratio, contrast
      videoWorker.js            Worker thread for chafa-wasm rendering
    audio/
      AudioBridge.js            Direct SDL2 audio output
    input/
      InputManager.js           Gamepad polling + keyboard fallback
      InputMap.js               W3C <-> libretro button mapping tables
    constants/
      libretro.js               Libretro C API constants
  cores/                        Pre-built .wasm + .js glue files
  scripts/
    build-core.sh               Emscripten build for any libretro core
    build-all-cores.sh          Batch build
    cores/*.sh                  Per-core build configs
```

### Key Modules

**LibretroHost** (`src/core/LibretroHost.js`) is the central orchestrator. It:

1. Loads a WASM core via `CoreLoader`
2. Registers 6 JavaScript callbacks as WASM function pointers using Emscripten's `addFunction()`:
   - `retro_environment` — handles 20+ environment commands from the core (pixel format negotiation, directory queries, variable configuration, capability reporting)
   - `retro_video_refresh` — receives framebuffer data each frame
   - `retro_audio_sample_batch` — receives batched stereo audio samples
   - `retro_audio_sample` — receives individual stereo samples (legacy fallback)
   - `retro_input_poll` — triggers gamepad state refresh
   - `retro_input_state` — returns button/axis state for a given port, device, and button ID
3. Allocates the ROM and `retro_game_info` struct in WASM memory
4. Reads `retro_system_av_info` to get screen dimensions, FPS, and audio sample rate
5. Runs the frame loop at the correct FPS using `setTimeout`/`setImmediate` hybrid timing

**VideoOutput** (`src/video/VideoOutput.js`) converts pixel data from the WASM heap into terminal art:

- Supports three pixel formats: RGB565, XRGB8888, 0RGB1555
- Uses pre-computed lookup tables (32-entry and 64-entry `Uint8Array`s) for 16-bit to 8-bit color conversion — no division in the hot loop
- Default half-block mode (▀▄) doubles vertical resolution and matches pixel art aesthetic
- Optional detailed mode (`--ascii`) uses block/border Unicode symbols for more variety
- Contrast boost option for low-contrast games (Atari, etc.)
- Renders every Nth frame (configurable, default 2) to avoid overwhelming terminal I/O
- Runs chafa conversion in a worker thread to keep the main loop responsive

**AudioBridge** (`src/audio/AudioBridge.js`) sends audio directly to SDL2:

- Opens an SDL2 audio device in S16 stereo format (matches libretro exactly)
- Zero-copy path: passes WASM memory buffer directly to SDL2's queue
- No sample format conversion needed — libretro and SDL2 both use int16

**InputManager** (`src/input/InputManager.js`) multiplexes gamepad and keyboard input:

- Calls `navigator.getGamepads()` (provided by gamepad-node) each frame
- Maps W3C standard button indices to libretro joypad IDs via `InputMap`
- Supports input bitmasks for modern cores (mGBA, etc.) that query all buttons at once
- Supports analog sticks (W3C float axes converted to libretro int16 range)
- Falls back to keyboard for player 1 using stdin raw mode with frame-based key hold timing

### Build System

`scripts/build-core.sh` compiles any libretro core to WASM:

1. Clones the core repo (`git clone --depth 1`)
2. Builds with `emmake make -f Makefile.libretro platform=emscripten`
3. Links the output with `emcc` using flags:
   - `-O3` — full optimization
   - `-s MODULARIZE=1 -s EXPORT_ES6=1` — ES module factory
   - `-s ENVIRONMENT=node` — Node.js target
   - `-s ALLOW_MEMORY_GROWTH=1` — dynamic memory (32MB initial, 256MB max)
   - `-s ALLOW_TABLE_GROWTH=1` — required for `addFunction()` callback registration
   - `-s FILESYSTEM=0` — no Emscripten FS (host handles I/O)
4. Exports 23 libretro API functions + Emscripten runtime helpers (`addFunction`, `HEAPU8`, `setValue`, etc.)

## Programmatic API

```javascript
import { LibretroHost, VideoOutput, AudioBridge, InputManager, SaveManager } from 'retroemu';

const video = new VideoOutput();
await video.init();

const audio = new AudioBridge();
const input = new InputManager();
const saves = new SaveManager('./saves');

const host = new LibretroHost({
  videoOutput: video,
  audioBridge: audio,
  inputManager: input,
  saveManager: saves,
});

await host.loadAndStart('./game.nes');

// Later:
await host.saveState(0);
await host.loadState(0);
host.reset();
await host.shutdown();
```

## Dependencies

| Package | Purpose |
|---------|---------|
| [gamepad-node](../gamepad-node/) | W3C Gamepad API for Node.js via SDL2 — 2100+ controllers with standard mapping |
| [@kmamal/sdl](https://github.com/kmamal/node-sdl) | Native SDL2 bindings for Node.js — audio output and gamepad input |
| [chafa-wasm](https://github.com/nicholasgasior/chafa-wasm) | Image-to-ANSI conversion — auto-detects Sixel, Kitty, or Unicode block art |

## Acknowledgments

This project is built on top of the amazing work by the [libretro](https://www.libretro.com/) team and the [RetroArch](https://www.retroarch.com/) community. All emulator cores are libretro cores compiled to WebAssembly:

- **libretro** provides a standardized API that allows emulator cores to be written once and run on many frontends
- **RetroArch** is the reference frontend implementation and home to most libretro core development
- Individual core authors and maintainers who have created and continue to improve these emulators

Without the libretro ecosystem and the open-source emulation community, this project would not be possible.

## License

MIT
