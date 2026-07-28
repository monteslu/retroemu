# retroemu

Terminal-based retro game emulator. Play classic console games directly in your
terminal using [libretro](https://www.libretro.com/) WASM cores.

- **25+ retro systems** — NES, SNES, Game Boy, Genesis, Atari, and more
- **Native game formats** — run [wasmcart](https://github.com/wasmcart/wasmcart) `.wasc` games (WASM, any language) and [jsgame](https://github.com/monteslu/jsgamelauncher) `.jsgame` JS games — rendered right in the terminal like everything else
- **PICO-8** — play `.p8` and `.p8.png` carts via [FAKE-08](https://github.com/jtothebell/fake-08) (MIT, no BIOS); thousands of free community carts run as-is
- **Multiple video outputs** — terminal (ANSI art), SDL window, or both simultaneously
- **Truecolor ANSI rendering** — half-block characters for clean pixel art
- **2100+ controllers supported** — via [SDL2](https://www.libsdl.org) with automatic mapping
- **Low-latency audio** — direct SDL2 audio output
- **Save states & battery saves** — automatic SRAM persistence

```
retroemu game.nes
```

## Supported Systems

The emulator auto-detects systems by file extension. All cores are from the [libretro](https://www.libretro.com/) project, compiled to WebAssembly. The mainstream cores (NES, SNES, Game Boy, Genesis, N64, PlayStation, GameTank, PICO-8, …) are consumed from [romdev](https://github.com/monteslu/romdev)'s pinned, hardened `romdev-core-*` / `romdev-platform-*` packages rather than built here — one shared set of core builds instead of two. **PICO-8** (`.p8` / `.p8.png`) runs via the [FAKE-08](https://github.com/jtothebell/fake-08) core (MIT, no BIOS) at 128×128 with sound. The remaining, romdev-less cores (Atari 800, PC-Engine CD, MSX/fmsx, ZX Spectrum, ColecoVision, NGP, WonderSwan, mupen64plus-next, PCSX-ReARMed, snes9x2010, Vectrex) are still bundled in `cores/`.

### Nintendo

| System | ROM Extensions | Core |
|--------|----------------|------|
| NES / Famicom | `.nes` `.fds` `.unf` `.unif` | [fceumm](https://github.com/libretro/libretro-fceumm) |
| Super Nintendo | `.sfc` `.smc` | [snes9x](https://github.com/libretro/snes9x) |
| Game Boy | `.gb` | [gambatte](https://github.com/libretro/gambatte-libretro) |
| Game Boy Color | `.gbc` | [gambatte](https://github.com/libretro/gambatte-libretro) |
| Game Boy Advance | `.gba` | [mgba](https://github.com/libretro/mgba) |
| Nintendo 64 | `.z64` `.n64` `.v64` | [parallel-n64](https://github.com/libretro/parallel-n64) |

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
| MSX / MSX2 | `.mx1` `.mx2` `.rom` `.dsk` `.cas` | [fmsx](https://github.com/libretro/fmsx-libretro) (C-BIOS bundled — see [BIOS](#bios--system-roms)) |

### Native Game Formats

Beyond emulated consoles, retroemu runs two *native* game formats — real WASM/JS games (not
emulation). They render into the same terminal (ANSI art) / SDL pipeline as every emulated system.

| Format | Extensions | Runtime | Description |
|--------|------------|---------|-------------|
| wasmcart | `.wasm` `.wasc` | [wasmcart](https://github.com/wasmcart/wasmcart) (2026) | Standalone WASM games — compile from any language to the wasmcart ABI. Software rendering or GPU-accelerated (OpenGL ES 3.0). |
| jsgame | `.jsgame` `.jsg` | [rungame](https://www.npmjs.com/package/rungame) (2024) | JavaScript games (canvas / WebGL) run in a sandboxed realm. retroemu drives them headless and renders the frames itself. |

GL carts (those importing from the `gl` WASM module) are automatically detected. retroemu creates an EGL context via [native-gles](https://github.com/monteslu/native-gles) and provides GPU-accelerated rendering. The GL output is read back via `glReadPixels` for terminal display, or rendered directly to an SDL window.

Just run `retroemu <rom-file>` and the correct core loads automatically based on the file extension.

**ZIP support:** ROMs can be provided inside `.zip` archives — the emulator will automatically extract and load the first supported ROM file found.

## How It Works

The emulator loads libretro cores compiled to WebAssembly via
[Emscripten](https://emscripten.org). Each frame, the WASM core executes one tick of the emulated CPU, then calls back into JavaScript with:

- **Video**: A raw pixel framebuffer (RGB565, XRGB8888, or 0RGB1555) that gets converted to RGBA and rendered to the terminal as truecolor ANSI art via [@monteslu/chafa-wasm](https://github.com/monteslu/chafa-wasm) in a worker thread
- **Audio**: Interleaved int16 stereo samples sent directly to SDL2 audio device (via [@kmamal/sdl](https://github.com/kmamal/node-sdl))
- **Input**: Polled from physical gamepads through the W3C Gamepad API (via [gamepad-node](https://github.com/monteslu/gamepad-node)), with keyboard fallback

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

- **[Node.js](https://nodejs.org)** >= 22.0.0 (for ES modules and worker threads)
- **[Emscripten SDK](https://emscripten.org)** (only needed for building cores from source)
- **A truecolor terminal** (iTerm2, Kitty, Alacritty, Windows Terminal, GNOME Terminal, etc.)

## Installation

```bash
npm install -g retroemu
```

## Building Cores

Cores must be compiled from C/C++ source to WASM using [Emscripten](https://emscripten.org).

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
  --bios-dir <dir>     Directory holding BIOS/system ROMs (PCE-CD, ColecoVision)
  --core-option k=v    Set a libretro core option (repeatable),
                       e.g. --core-option fmsx_mode=MSX2
  --frame-skip <n>     Render every Nth frame to terminal (default: 2)
  --contrast <n>       Contrast boost, 1.0=normal, 1.5+=enhanced (default: 1.0)

Video output:
  --video <mode>       Output mode: terminal (default), sdl, both
  --scale <n>          SDL window scale factor (default: 2)

Terminal graphics options:
  --symbols <type>     Symbol set to use for rendering:
                       block (default), half, ascii, ascii+block, solid,
                       stipple, quad, sextant, octant, braille, matrix
  --colors <mode>      Color mode: true (default), 256, 16, 2
  --fg-only            Foreground color only (black background)
  --dither             Enable Floyd-Steinberg dithering

Picture:
  --video-filter <f>   CRT post-process for SDL modes:
                       none (default), sharp, scanlines, crt
  --fullscreen, -f     Start the SDL window fullscreen

Gameplay:
  --cheats <json>      Cheat codes: inline JSON or @file
                       [{ "code": "SXIOPO", "enabled": true, "desc": "..." }]
                       Codes go straight to the core, so Game Genie,
                       GameShark/PAR and raw address:value all work wherever
                       that core supports them.

Remote play ("a very long couch"):
  --host-remote        Host this game; prints a share code for a friend
  --join <code>        Join a hosted game as player 2 (no ROM needed)
  --watch <code>       Watch a hosted game (spectator, sends no input)

Frontend integration:
  --control            Enable the IPC session channel (spawn with stdio 'ipc')
  --input-map <json>   Controller remap: inline JSON or @file — per-device
                       bindings keyed by SDL GUID, plus player port order
  --cheats <json>      Cheat codes: inline JSON or @file
                       ([{code, enabled, desc}]; the core decodes the format)
  --video-filter <f>   CRT post-process: none, sharp, scanlines, crt (SDL modes)
  --ff-speed <n>       Fast-forward multiplier, 0 = uncapped (default: 4)
  --no-rewind          Disable rewind history (saves memory + per-frame work)

Other:
  --uncapped           Run as fast as the host allows (no 60 FPS cap)
  --no-gamepad         Disable gamepad input (keyboard only)
  --debug-input        Log raw SDL controller events (diagnosing dead pads)
  -h, --help           Show help
```

Examples:

```bash
retroemu ~/roms/my_game.nes
retroemu ~/roms/my_game.zip            # extracts ROM from ZIP automatically
retroemu --video sdl ~/roms/my_game.nes              # SDL window instead of terminal
retroemu --video both ~/roms/my_game.nes             # terminal + SDL window
retroemu --frame-skip 3 ~/roms/my_game.sfc
retroemu --save-dir ~/.emu/saves ~/roms/my_game.gbc
retroemu --contrast 1.5 ~/roms/my_game.a26           # boost contrast for dark games
retroemu --symbols braille --colors 2 ~/roms/my_game.gb   # monochrome braille
retroemu --symbols ascii --fg-only ~/roms/my_game.nes     # ASCII on black background

# WASM carts (software rendering or GL-accelerated)
retroemu my_cart.wasm                                # software cart in terminal
retroemu --video sdl my_game.wasc                    # GL cart in SDL window

# CRT look
retroemu --video sdl --video-filter crt ~/roms/sonic.md

# Cheats (the core decodes the format)
retroemu --video sdl --cheats '[{"code":"SXIOPO","enabled":true}]' smb.nes

# Remote play — P1 hosts, P2 joins with the printed code
retroemu --video sdl --host-remote ~/roms/contra.nes
retroemu --join ABC-DEF-GHJ                          # play as P2
retroemu --watch ABC-DEF-GHJ                         # spectate
```

### In-game overlay

In SDL modes, **Start+Select** (held ~½ s) or **ESC** opens a menu drawn over
the game: Resume · Save State · Load State · Screenshot · Fullscreen · Quit.
Navigate with the d-pad/arrows and A/Enter. The core pauses while it's open.
Holding Start+Select for ~2 s still force-quits.

### Remote play

`--host-remote` prints a share code like `4PA-UHX-RJJ`; a friend runs
`retroemu --join <code>` and is player 2 within seconds — **they need no ROM
and no core**, because your machine does the emulating. Video (changed rows,
deflated), audio (12 kHz mono ADPCM, ~6 KB/s) and their controller (7 bytes at
60 Hz) travel P2P over WebRTC; a signaling server sees ~3 KB and nothing more.
The emulator itself never learns it's networked — a guest is just another
controller on port 2.

Share codes use a base24 alphabet with no ambiguous characters (no `0`/`O`,
`1`/`I`/`L`, `2`/`Z`, `5`/`S`, `8`/`B`), so they survive being read aloud.
Full protocol: `romdeck/docs/RemotePlay.md`.

## Rendering

The emulator uses [@monteslu/chafa-wasm](https://github.com/monteslu/chafa-wasm) (SIMD-optimized fork) to convert pixel data to ANSI sequences.

### Symbol Sets (`--symbols`)

| Symbol Set | Description | Characters |
|------------|-------------|------------|
| `block` (default) | Full block characters | ▀ ▄ █ ░ ▒ ▓ |
| `half` | Vertical half blocks only | ▀ ▄ |
| `ascii` | ASCII printable characters | @ # % & * |
| `ascii+block` | ASCII + block characters | @ # █ ▀ ▄ (single-byte friendly) |
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

Any gamepad recognized by [gamepad-node](https://github.com/monteslu/gamepad-node) works automatically. Buttons are mapped positionally — the south face button is always B, east is A, etc. — regardless of the controller's printed labels.

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

## BIOS / system ROMs

Almost nothing here needs one. Cartridge systems — NES, SNES, Game Boy/GBC/GBA,
Genesis/SMS/GG, Atari 2600/7800/Lynx, Neo Geo Pocket, WonderSwan, Vectrex, N64,
PICO-8 — put the whole machine in the cartridge, so the ROM is all you need.

Several systems that are *usually* described as needing firmware don't here,
because the core or this package supplies a free implementation:

| System | Status |
|--------|--------|
| Atari 800 / 5200 / XL / XE | **Bundled in the core** — atari800 falls back to AltirraOS, a from-scratch replacement |
| ZX Spectrum | **Bundled in the core** — fuse embeds the standard Spectrum ROMs (Pentagon/Scorpion clones are the exception) |
| MSX / MSX2 | **Bundled here** — [C-BIOS](https://cbios.sourceforge.net/) in `system/msx/` (2-clause BSD) |
| PlayStation | **Optional** — pcsx_rearmed falls back to its HLE BIOS |

Two systems genuinely need a dump you provide yourself, because no free
replacement exists: **PC Engine CD** (`syscard3.pce`) and **ColecoVision**.
Point `--bios-dir` at a directory containing them.

### About the bundled MSX BIOS

C-BIOS is an independent, from-scratch MSX BIOS — not a dump — so it ships
freely (see `system/msx/C-BIOS-LICENSE.txt`). It runs most cartridge games but
implements **no disk, no cassette and no BASIC**, and its MSX2/MSX2+ modes do
not produce a picture. MSX therefore defaults to `fmsx_mode=MSX1`, which is what
cartridge games use.

If you have real MSX BIOS dumps, point `--bios-dir` at them and pick a machine:

```bash
retroemu game.rom --bios-dir ~/bios/msx --core-option fmsx_mode=MSX2
```

## Save System

**SRAM** (battery-backed saves) is automatically saved when you quit and loaded when you start a ROM. Save files are stored as `{rom-name}.srm` in the save directory.

**Save states** capture the full emulation state (CPU registers, memory, video state, etc.) and are stored as `{rom-name}.state0`. Use F5 to save and F7 to load.

Default save directory: `saves/` next to the ROM file, configurable with `--save-dir`.

## Architecture

```
retroemu/
  bin/cli.js                    CLI entry point (libretro cores + wasmcart runner + GL pre-scan)
  index.js                      Library exports
  src/
    core/
      LibretroHost.js           Main engine: WASM loading, callback registration, frame loop
      CoreLoader.js             Dynamic import of Emscripten WASM modules
      LibretroGL.js             HW render support (SET_HW_RENDER, FBO readback, context lifecycle)
      LibretroGLBridge.js       Emscripten GL env imports → native-gles bridge (541 functions)
      SystemDetector.js         ROM extension -> system/core mapping
      SaveManager.js            SRAM and save state persistence
      RomLoader.js              ROM loading + ZIP extraction
    video/
      VideoOutput.js            Pixel format conversion, aspect ratio, terminal/SDL/both modes
      SDLRenderer.js            SDL2 window rendering with aspect ratio preservation
      videoWorker.js            Worker thread for chafa-wasm terminal rendering
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

### WASM Cart Runner

When a `.wasm` or `.wasc` file is loaded, retroemu uses [wasmcart](https://github.com/wasmcart/wasmcart) instead of libretro:

```
 retroemu <cart.wasc>
   │
   CartHost  ── loads WASM cart, provides asset API + GL backend, drives wc_render() at 60fps
   │
   cart.wc_render()
     │
     ├── [GL carts] glClear/glDraw* ──► native-gles ──► EGL pbuffer ──► glReadPixels ──► SDL/chafa
     ├── [SW carts] write to XRGB framebuffer ──► VideoOutput ──► SDL/chafa
     ├── read pads[] ──► InputManager.poll() ──► navigator.getGamepads()
     └── write audio_ring[] ──► AudioBridge ──► SDL2 ──► speakers
```

For GL carts, the readback pipeline is: `glFinish()` → `glReadPixels(RGBA)` → vertical flip → RGBA→XRGB → display. At 320x240 this adds ~3.5ms per frame.

### GPU-Accelerated Libretro Cores (N64)

Some libretro cores use hardware-accelerated GPU rendering via `RETRO_ENVIRONMENT_SET_HW_RENDER`. retroemu supports this using [webgl-node](https://github.com/monteslu/webgl-node) to provide a WebGL2 context backed by [native-gles](https://github.com/monteslu/native-gles).

```
 retroemu <rom.z64>
   │
   LibretroHost  ── creates WebGL2 context via webgl-node, initializes Emscripten GL
   │
   core._retro_run()
     │
     ├── GL draw calls ──► Emscripten GLctx ──► webgl-node ──► native-gles EGL pbuffer
     └── video_refresh(RETRO_HW_FRAME_BUFFER_VALID)
   │
   after retro_run():
     glFinish() → glReadPixels(FBO 0) → vertical flip → onCartFrameRGBA → SDL/chafa
```

The N64 core (parallel-n64) uses the Glide64 GPU plugin — the same one used by [N64Wasm](https://github.com/nbarkhina/N64Wasm) for full-speed browser N64 emulation.

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
   - `-s ENVIRONMENT=node` — Node.js target (GPU cores use `node,web` for WebGL context support)
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

### Session control (what frontends use)

`LibretroHost` also exposes the surface a frontend drives over `--control`:

```javascript
host.pause(); host.resume();
host.setSpeed(4);                       // 0 = uncapped
const blob = host.serializeState();     // Buffer, or null if unsupported
host.unserializeState(blob);
host.setCheats([{ code: 'SXIOPO', enabled: true }]);   // core decodes it

// Memory — the same libretro surface cheats and achievements ride on
host.memoryInfo();                      // regions this core actually exposes
host.readMemory(2, 0x0000, 256);        // system RAM → Buffer
host.writeMemory(2, 0x0010, [0xde, 0xad]);
```

`host.onFrameHook` fires after every executed frame (rewind uses it), and
`AudioBridge.onPcm` taps the PCM going to the speakers (remote play uses it).

#### The `--control` wire protocol

A frontend does not import any of the above. It spawns retroemu with an IPC
channel and speaks JSON-RPC over it, which is what keeps a crashing core from
taking the frontend down with it:

```javascript
const child = spawn('retroemu', [rom, '--video', 'sdl', '--control'],
  { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
```

```
parent → child   { id, method, params }
child  → parent  { id, result }  |  { id, error }
child  → parent  { event, ...payload }        // unsolicited
```

**Methods**

| Group | Methods |
|---|---|
| Lifecycle | `getStatus`, `pause`, `resume`, `reset`, `quit` |
| State | `saveState`, `loadState`, `rewind` |
| Presentation | `screenshot`, `setFullscreen`, `setVideoFilter`, `setSpeed`, `menu` |
| Input | `listPads`, `setInputMap` |
| Core | `listCoreOptions`, `setCoreOption`, `setCheats` |
| Memory | `memoryInfo`, `readMemory`, `writeMemory` |
| Remote play | `remoteHost`, `remoteStop`, `remoteStatus` |

**Events**

| Event | When |
|---|---|
| `ready` | host is up; carries platform, core and AV info |
| `autosave` | final state blob, pushed **before** teardown so the frontend can persist a resume point |
| `remote` | remote-play session state changed |

Binary payloads cross the channel as **base64**, since IPC messages are JSON.
`saveState` returns `{ stateB64, screenshotPngB64, frameCount, size }`,
`loadState` expects that same `stateB64` back as a param, and `screenshot`
returns `{ pngB64, width, height }`. Decode with
`Buffer.from(stateB64, 'base64')`.

Non-libretro sessions (wasmcart, jsgame) accept the channel but report
`stateSupported: false` — save states are a libretro feature.

### Remote play

```javascript
import { RemoteHost, RemoteGuest, formatCode } from 'retroemu/src/net/RemotePlay.js';

const remote = new RemoteHost({ videoOutput, inputManager, audioBridge });
const { code } = await remote.start();   // e.g. "4PA-UHX-RJJ"
// …later
await remote.stop();
```

The guest side is `RemoteGuest` (or just `retroemu --join <code>`), which
needs no ROM and no core.

## Dependencies

| Package | Purpose |
|---------|---------|
| [gamepad-node](https://github.com/monteslu/gamepad-node) | W3C Gamepad API for Node.js via SDL2 — 2100+ controllers with standard mapping |
| [@kmamal/sdl](https://github.com/kmamal/node-sdl) | Native SDL2 bindings for Node.js — audio output, SDL window rendering, gamepad input |
| [@monteslu/chafa-wasm](https://github.com/monteslu/chafa-wasm) | Image-to-ANSI conversion — auto-detects Sixel, Kitty, or Unicode block art |
| [wasmcart](https://github.com/wasmcart/wasmcart) | WASM cart host — loads .wasm/.wasc carts, provides ABI (input, audio, assets, GL) |
| [native-gles](https://github.com/monteslu/native-gles) | OpenGL ES 3.0 Node.js addon — EGL pbuffer context + ~100 GL function bindings |
| [webgl-node](https://github.com/monteslu/webgl-node) | WebGL2 context for Node.js — provides canvas + WebGL2RenderingContext backed by native-gles |
| [hsync](https://www.npmjs.com/package/hsync) | Remote play signaling — brokers the WebRTC handshake, then drops out of the loop |
| [node-datachannel](https://github.com/murat-dogan/node-datachannel) | WebRTC data channels in Node (libdatachannel) — the P2P transport for remote play |

## Acknowledgments

This project is built on top of the amazing work by the [libretro](https://www.libretro.com/) team and the [RetroArch](https://www.retroarch.com/) community. All emulator cores are libretro cores compiled to WebAssembly:

- **libretro** provides a standardized API that allows emulator cores to be written once and run on many frontends
- **RetroArch** is the reference frontend implementation and home to most libretro core development
- Individual core authors and maintainers who have created and continue to improve these emulators

Without the libretro ecosystem and the open-source emulation community, this project would not be possible.

## License

MIT
