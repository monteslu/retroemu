#!/usr/bin/env node

import { resolve, dirname, basename } from 'path';
import { existsSync } from 'fs';
import { LibretroHost } from '../src/core/LibretroHost.js';
import { VideoOutput } from '../src/video/VideoOutput.js';
import { AudioBridge } from '../src/audio/AudioBridge.js';
import { InputManager } from '../src/input/InputManager.js';
import { SaveManager } from '../src/core/SaveManager.js';
import { detectSystem, getSupportedExtensions } from '../src/core/SystemDetector.js';
import { loadRom, isZipFile } from '../src/core/RomLoader.js';

// Parse arguments
const args = process.argv.slice(2);
let romPath = null;
let saveDir = null;
let frameSkip = 2;
let contrast = 1.0;
let symbols = 'block';
let colors = 'true';
let fgOnly = false;
let dither = false;
let disableGamepad = false;
let debugInput = false;
let videoMode = 'terminal';
let scale = 2;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--save-dir' && args[i + 1]) {
    saveDir = resolve(args[++i]);
  } else if (args[i] === '--frame-skip' && args[i + 1]) {
    frameSkip = parseInt(args[++i], 10);
  } else if (args[i] === '--contrast' && args[i + 1]) {
    contrast = parseFloat(args[++i]);
  } else if (args[i] === '--symbols' && args[i + 1]) {
    symbols = args[++i];
  } else if (args[i] === '--colors' && args[i + 1]) {
    colors = args[++i];
  } else if (args[i] === '--fg-only') {
    fgOnly = true;
  } else if (args[i] === '--dither') {
    dither = true;
  } else if (args[i] === '--video' && args[i + 1]) {
    videoMode = args[++i];
  } else if (args[i] === '--scale' && args[i + 1]) {
    scale = parseInt(args[++i], 10);
  } else if (args[i] === '--no-gamepad') {
    disableGamepad = true;
  } else if (args[i] === '--debug-input') {
    debugInput = true;
  } else if (args[i] === '--help' || args[i] === '-h') {
    printUsage();
    process.exit(0);
  } else if (!args[i].startsWith('-')) {
    romPath = resolve(args[i]);
  }
}

if (!romPath) {
  printUsage();
  process.exit(1);
}

if (!existsSync(romPath)) {
  console.error(`File not found: ${romPath}`);
  process.exit(1);
}

// Load ROM (handles ZIP extraction if needed)
let romInfo;
try {
  romInfo = await loadRom(romPath);
  if (romInfo.zipEntry) {
    console.log(`Extracted: ${romInfo.zipEntry}`);
  }
} catch (err) {
  console.error(`Error loading ROM: ${err.message}`);
  process.exit(1);
}

// Detect system from the actual ROM file (inside ZIP if applicable)
const system = detectSystem(romInfo.romPath);
if (!system) {
  console.error(`Unsupported ROM file extension.`);
  console.error(`Supported: ${getSupportedExtensions().join(', ')}`);
  process.exit(1);
}

// Default save dir is alongside the original file (ZIP or ROM)
if (!saveDir) {
  saveDir = resolve(dirname(romPath), 'saves');
}

// Initialize subsystems
const videoOutput = new VideoOutput({ video: videoMode, scale });
await videoOutput.init();
videoOutput.setFrameSkip(frameSkip);
videoOutput.setContrast(contrast);
videoOutput.setSymbols(symbols);
videoOutput.setColors(colors);
videoOutput.setFgOnly(fgOnly);
videoOutput.setDither(dither);

const audioBridge = new AudioBridge();
const inputManager = new InputManager({ disableGamepad, debugInput });
const saveManager = new SaveManager(saveDir);

const host = new LibretroHost({
  videoOutput,
  audioBridge,
  inputManager,
  saveManager,
});

// Enter alternate screen buffer, hide cursor
process.stdout.write('\x1b[?1049h\x1b[?25l');

// Clean shutdown handler
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  await host.shutdown();

  try {
    inputManager.destroy();
  } catch {
    // Ignore SDL controller cleanup errors
  }

  // Restore terminal
  process.stdout.write('\x1b[?1049l\x1b[?25h');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => {
  // Ensure terminal is restored even on unexpected exit
  process.stdout.write('\x1b[?1049l\x1b[?25h');
});

// Hotkeys via stdin (handled by InputManager, but save/load state needs extra handling)
if (process.stdin.isTTY) {
  process.stdin.on('data', async (key) => {
    // F5 = save state (ESC [ 1 5 ~)
    if (key === '\x1b[15~') {
      await host.saveState(0);
    }
    // F7 = load state (ESC [ 1 8 ~)
    if (key === '\x1b[18~') {
      await host.loadState(0);
    }
    // F1 = reset (ESC [ 1 1 ~)
    if (key === '\x1b[11~') {
      host.reset();
    }
    // ESC = quit
    if (key === '\x1b' && key.length === 1) {
      await shutdown();
    }
  });
}

// Start retroemulation
try {
  await host.loadAndStart(romInfo.romPath, { saveDir, romData: romInfo.data });
} catch (err) {
  process.stdout.write('\x1b[?1049l\x1b[?25h');
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

function printUsage() {
  console.log(`retroemu - Terminal retro game retroemulator`);
  console.log(``);
  console.log(`Usage: retroemu [options] <rom-file>`);
  console.log(``);
  console.log(`Options:`);
  console.log(`  --save-dir <dir>     Directory for save files (default: <rom-dir>/saves)`);
  console.log(`  --frame-skip <n>     Render every Nth frame to terminal (default: 2)`);
  console.log(`  --contrast <n>       Contrast boost, 1.0=normal, 1.5=more contrast (default: 1.0)`);
  console.log(``);
  console.log(`Graphics options:`);
  console.log(`  --video <mode>       Video output: terminal, sdl, both (default: terminal)`);
  console.log(`  --scale <n>          SDL window scale factor (default: 2)`);
  console.log(`  --symbols <type>     Symbol set: block, half, ascii, solid, stipple,`);
  console.log(`                       quad, sextant, octant, braille (default: block)`);
  console.log(`  --colors <mode>      Color mode: true, 256, 16, 2 (default: true)`);
  console.log(`  --fg-only            Foreground color only (black background)`);
  console.log(`  --dither             Enable Floyd-Steinberg dithering`);
  console.log(``);
  console.log(`Other:`);
  console.log(`  --no-gamepad         Disable gamepad input (keyboard only)`);
  console.log(`  -h, --help           Show this help`);
  console.log(``);
  console.log(`ROM files can be provided directly or inside a .zip archive.`);
  console.log(``);
  console.log(`Supported systems:`);
  console.log(`  Nintendo   NES (.nes), SNES (.sfc, .smc), GB/GBC (.gb, .gbc), GBA (.gba)`);
  console.log(`  Sega       Genesis (.md, .gen), Master System (.sms), Game Gear (.gg)`);
  console.log(`  Atari      2600 (.a26), 5200 (.a52), 7800 (.a78), 800/XL/XE, Lynx (.lnx)`);
  console.log(`  NEC        TurboGrafx-16 / PC Engine (.pce)`);
  console.log(`  SNK        Neo Geo Pocket (.ngp, .ngc)`);
  console.log(`  Bandai     WonderSwan (.ws, .wsc)`);
  console.log(`  Other      ColecoVision (.col), Vectrex (.vec)`);
  console.log(`  Computers  ZX Spectrum (.tzx, .z80), MSX (.mx1, .mx2, .rom)`);
  console.log(`  Sony       PlayStation (.iso, .pbp, .m3u)`);
  console.log(``);
  console.log(`Controls:`);
  console.log(`  Gamepad    Automatically detected (2100+ controllers)`);
  console.log(`  Keyboard   Arrow keys, Z/X (B/A), A/S (Y/X), Enter (Start), Shift (Select)`);
  console.log(``);
  console.log(`Hotkeys:`);
  console.log(`  F1         Reset`);
  console.log(`  F5         Save state`);
  console.log(`  F7         Load state`);
  console.log(`  ESC        Quit`);
  console.log(`  Start+Sel  Quit (gamepad, hold 0.5s)`);
}
