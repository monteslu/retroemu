// retroemu main — the actual CLI. Loaded by bin/cli.js AFTER the jsgame re-exec
// decision, so the heavy SDL/GL imports below init exactly once (no double-init crash on macOS).
import { resolve, dirname, basename, extname, join } from 'path';
import { existsSync, writeFileSync, readFileSync, statSync, watch as watchFs } from 'fs';
import { LibretroHost } from '../src/core/LibretroHost.js';
import { VideoOutput } from '../src/video/VideoOutput.js';
import { AudioBridge } from '../src/audio/AudioBridge.js';
import { InputManager } from '../src/input/InputManager.js';
import { SaveManager } from '../src/core/SaveManager.js';
import { detectSystem, getSupportedExtensions } from '../src/core/SystemDetector.js';
import { parseAspectMode } from '../src/video/aspect.js';
import { loadRom, isZipFile } from '../src/core/RomLoader.js';
import { CartHost, BUTTON } from 'wasmcart';
import { createHostSession as createJsGameSession } from 'rungame';
import gl from 'native-gles';
import { WebGL2RenderingContext } from 'webgl-node';
import { SDL, shareSdl } from '../src/core/shared-sdl.js';

// Force gamepad-node + webaudio-node onto retroemu's single @kmamal/sdl instance, so a
// duplicate copy in the npm tree (common on a fresh macOS `npx` install) can't leave the
// controller reading a DIFFERENT SDL event queue than the one retroemu pumps → dead input.
shareSdl();

// Parse arguments
const args = process.argv.slice(2);
let romPath = null;
let saveDir = null;
let biosDir = null;       // --bios-dir: where cores look for BIOS/system ROMs
const coreOptions = {};   // --core-option key=value (repeatable), beats core defaults
let frameSkip = 2;
let contrast = 1.0;
let symbols = 'block';
let colors = 'true';
let fgOnly = false;
let dither = false;
let termFps = 30;
let disableGamepad = false;
let debugInput = false;

// Verbose dev logging (GL/cart/perf/fbo internals). Off by default so the console stays
// clean; enable with RETROEMU_DEBUG=1 (or --debug). Real errors + --help are never gated.
const DEBUG = !!process.env.RETROEMU_DEBUG || process.argv.includes('--debug');
const dlog = (...a) => { if (DEBUG) console.error(...a); };
let videoMode = 'terminal';  // terminal | sdl | both
let aspectMode = 'tv';       // tv (physical medium) | native (square pixels) | core
let sdlScale = 1;
let preferredWidth = 0;   // 0 = no preference (cart chooses)
let preferredHeight = 0;
let fullscreen = false;
let uncapped = false;
let controlMode = false; // --control: IPC session channel for frontends (romdeck)
let inputRemap = null;   // --input-map: per-device bindings + player order
let videoFilter = 'none'; // --video-filter: none | sharp | scanlines | crt
let shaderPreset = null;  // --shader: path to a .glslp preset (GPU, SDL modes)
let joinCode = null;      // --join/--watch: remote play guest
let watchOnly = false;
let hostRemote = false;   // --host-remote: start hosting immediately
let cheatList = null;     // --cheats: [{code, enabled, desc}]
let ffSpeed = 4;          // --ff-speed: multiplier the overlay/frontend fast-forwards at
let rewindEnabled = true; // --no-rewind: skip rewind snapshots entirely
let activeBezelPath = null;
let activeBezelConfig = {};
let activeBezelForce = false;
let activeBezelDev = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--save-dir' && args[i + 1]) {
    saveDir = resolve(args[++i]);
  } else if (args[i] === '--bios-dir' && args[i + 1]) {
    biosDir = resolve(args[++i]);
  } else if (args[i] === '--core-option' && args[i + 1]) {
    const raw = args[++i];
    const eq = raw.indexOf('=');
    if (eq <= 0) {
      console.error(`retroemu: --core-option expects key=value, got "${raw}"`);
      process.exit(1);
    }
    coreOptions[raw.slice(0, eq)] = raw.slice(eq + 1);
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
  } else if (args[i] === '--term-fps' && args[i + 1]) {
    termFps = parseInt(args[++i], 10) || 30;
  } else if (args[i] === '--no-gamepad') {
    disableGamepad = true;
  } else if (args[i] === '--debug-input') {
    debugInput = true;
  } else if (args[i] === '--video' && args[i + 1]) {
    const mode = args[++i];
    if (['terminal', 'sdl', 'both'].includes(mode)) {
      videoMode = mode;
    }
  } else if (args[i] === '--aspect' && args[i + 1]) {
    const mode = parseAspectMode(args[++i]);
    if (mode) {
      aspectMode = mode;
    } else {
      console.error(`--aspect: expected tv, native, or core (got "${args[i]}")`);
      process.exit(1);
    }
  } else if (args[i] === '--scale' && args[i + 1]) {
    sdlScale = parseInt(args[++i], 10) || 2;
  } else if (args[i] === '--res' && args[i + 1]) {
    const parts = args[++i].split('x');
    preferredWidth = parseInt(parts[0], 10) || 0;
    preferredHeight = parseInt(parts[1], 10) || 0;
  } else if (args[i] === '--fullscreen' || args[i] === '-f') {
    fullscreen = true;
  } else if (args[i] === '--uncapped') {
    uncapped = true;
  } else if (args[i] === '--control') {
    controlMode = true;
  } else if ((args[i] === '--join' || args[i] === '--watch') && args[i + 1]) {
    joinCode = args[++i];
    watchOnly = args[i - 1] === '--watch';
  } else if (args[i] === '--host-remote') {
    hostRemote = true;
  } else if (args[i] === '--video-filter' && args[i + 1]) {
    videoFilter = args[++i];
  } else if (args[i] === '--shader' && args[i + 1]) {
    shaderPreset = resolve(args[++i]);
  } else if (args[i] === '--ff-speed' && args[i + 1]) {
    // 0 = uncapped; anything else is clamped to the host's accepted range
    const v = Number(args[++i]);
    if (Number.isFinite(v) && v >= 0) ffSpeed = v;
  } else if (args[i] === '--no-rewind') {
    rewindEnabled = false;
  } else if (args[i] === '--active-bezel' && args[i + 1]) {
    activeBezelPath = resolve(args[++i]);
  } else if (args[i] === '--active-bezel-auto') {
    // Discover the same-basename sidecar next to the ROM -- either a packed
    // `Game.ab` or an unpacked `Game.ab/` directory works, matching romdev's
    // useActiveBezel discovery. A separate flag rather than a bare
    // --active-bezel: the ROM path follows positionally, and a bare form
    // would swallow it as the package path.
    activeBezelPath = 'discover';
  } else if (args[i] === '--active-bezel-config' && args[i + 1]) {
    const raw = args[++i];
    try {
      activeBezelConfig = JSON.parse(raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw);
    } catch (err) {
      console.error(`--active-bezel-config: ${err.message}`);
      process.exit(1);
    }
  } else if (args[i] === '--active-bezel-force') {
    activeBezelForce = true;
  } else if (args[i] === '--active-bezel-dev') {
    activeBezelDev = true;
  } else if (args[i] === '--cheats' && args[i + 1]) {
    const raw = args[++i];
    try {
      cheatList = JSON.parse(raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw);
    } catch (err) {
      console.error(`--cheats: ${err.message}`);
      process.exit(1);
    }
  } else if (args[i] === '--input-map' && args[i + 1]) {
    // JSON (inline or @path) describing per-device bindings + player order
    const raw = args[++i];
    try {
      const text = raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw;
      inputRemap = JSON.parse(text);
    } catch (err) {
      console.error(`--input-map: ${err.message}`);
      process.exit(1);
    }
  } else if (args[i] === '--help' || args[i] === '-h') {
    printUsage();
    process.exit(0);
  } else if (!args[i].startsWith('-')) {
    romPath = resolve(args[i]);
  }
}

// Remote play guest: no ROM, no core — the host is emulating. Hand off.
if (joinCode) {
  const { runJoin } = await import('./join.js');
  await runJoin(joinCode, { watchOnly, scale: sdlScale || 3 });
  await new Promise(() => {}); // stay alive until the window closes
}

if (!romPath) {
  printUsage();
  process.exit(1);
}

if (!existsSync(romPath)) {
  console.error(`File not found: ${romPath}`);
  process.exit(1);
}

// Load ROM (handles ZIP extraction if needed) — then detect system from actual ROM extension
let romInfo;
let system;

if (isZipFile(romPath)) {
  try {
    romInfo = await loadRom(romPath);
    if (romInfo.zipEntry) {
      dlog(`Extracted: ${romInfo.zipEntry}`);
    }
    system = detectSystem(romInfo.romPath);
  } catch (err) {
    console.error(`Error loading ROM: ${err.message}`);
    process.exit(1);
  }
} else {
  // Load ROM data (also handles .bin magic byte detection for N64, etc.)
  try {
    romInfo = await loadRom(romPath);
  } catch (err) {
    console.error(`Error loading ROM: ${err.message}`);
    process.exit(1);
  }
  system = detectSystem(romInfo.romPath);
}

if (!system) {
  console.error(`Unsupported file extension.`);
  console.error(`Supported: ${getSupportedExtensions().join(', ')}`);
  process.exit(1);
}

const isCart = system.system === 'wasmcart';
const isJsGame = system.system === 'jsgame';

// Default save dir is alongside the original file (ZIP or ROM)
if (!saveDir) {
  saveDir = resolve(dirname(romPath), 'saves');
}

// Pre-scan cart for GL usage — must create EGL context BEFORE SDL init
// (SDL's accelerated renderer conflicts with our EGL context on the same thread)
let cartUsesGL = false;
let glUseWindowSurface = false;
let glNoFBORedirect = false;
let cartManagesFBOs = false;
if (isCart) {
  const { readFile } = await import('fs/promises');
  let wasmBytes = await readFile(romPath);

  // If it's a .wasc (ZIP), extract cart.wasm for the pre-scan
  if (wasmBytes[0] === 0x50 && wasmBytes[1] === 0x4b) {
    const { inflateRawSync } = await import('zlib');
    // Quick ZIP parse: find cart.wasm entry
    // Read EOCD to get central directory
    let eocd = -1;
    for (let i = wasmBytes.length - 22; i >= Math.max(0, wasmBytes.length - 65558); i--) {
      if (wasmBytes[i] === 0x50 && wasmBytes[i+1] === 0x4b && wasmBytes[i+2] === 0x05 && wasmBytes[i+3] === 0x06) {
        eocd = i; break;
      }
    }
    if (eocd >= 0) {
      const dv = new DataView(wasmBytes.buffer, wasmBytes.byteOffset);
      const cdOff = dv.getUint32(eocd + 16, true);
      const cdCount = dv.getUint16(eocd + 10, true);
      // First parse manifest to find entry name
      let entryName = 'cart.wasm';
      let pos = cdOff;
      for (let i = 0; i < cdCount; i++) {
        const nameLen = dv.getUint16(pos + 28, true);
        const extraLen = dv.getUint16(pos + 30, true);
        const commentLen = dv.getUint16(pos + 32, true);
        const name = new TextDecoder().decode(wasmBytes.subarray(pos + 46, pos + 46 + nameLen));
        if (name === 'manifest.json') {
          const localOff = dv.getUint32(pos + 42, true);
          const lnLen = dv.getUint16(localOff + 26, true);
          const leLen = dv.getUint16(localOff + 28, true);
          const dataOff = localOff + 30 + lnLen + leLen;
          const comp = dv.getUint16(pos + 10, true);
          const compSize = dv.getUint32(pos + 20, true);
          let mData = wasmBytes.subarray(dataOff, dataOff + compSize);
          if (comp === 8) mData = inflateRawSync(mData);
          const manifest = JSON.parse(new TextDecoder().decode(mData));
          if (manifest.entry) entryName = manifest.entry;
        }
        pos += 46 + nameLen + extraLen + commentLen;
      }
      // Now find the WASM entry
      pos = cdOff;
      for (let i = 0; i < cdCount; i++) {
        const nameLen = dv.getUint16(pos + 28, true);
        const extraLen = dv.getUint16(pos + 30, true);
        const commentLen = dv.getUint16(pos + 32, true);
        const name = new TextDecoder().decode(wasmBytes.subarray(pos + 46, pos + 46 + nameLen));
        if (name === entryName) {
          const localOff = dv.getUint32(pos + 42, true);
          const lnLen = dv.getUint16(localOff + 26, true);
          const leLen = dv.getUint16(localOff + 28, true);
          const dataOff = localOff + 30 + lnLen + leLen;
          const comp = dv.getUint16(pos + 10, true);
          const compSize = dv.getUint32(pos + 20, true);
          wasmBytes = wasmBytes.subarray(dataOff, dataOff + compSize);
          if (comp === 8) wasmBytes = inflateRawSync(wasmBytes);
          break;
        }
        pos += 46 + nameLen + extraLen + commentLen;
      }
    }
  }

  let wasmModule;
  try {
    wasmModule = await WebAssembly.compile(wasmBytes);
  } catch (e) {
    // Fallback for carts using features like exnref that need flags
    // Skip pre-scan, let CartHost handle compilation
    wasmModule = null;
    dlog(`[warn] Pre-compile failed (${e.message}), skipping import scan`);
  }
  // Detect GL carts: imports from 'gl' module, or GL functions under 'env' (emscripten-style)
  const wasmImports = wasmModule ? WebAssembly.Module.imports(wasmModule) : [];
  // Any cart with GL imports uses GL. With gpu_api=1, even 2D carts render
  // through GL blit (texture upload + fullscreen quad). One display path for all carts.
  const hasGLImports = wasmImports.some(i =>
    i.module === 'gl' || (i.module === 'env' && i.kind === 'function' && i.name.startsWith('gl') && /^gl[A-Z]/.test(i.name)));
  cartUsesGL = hasGLImports || !wasmModule; // assume GL if pre-scan failed
  // Detect if cart manages its own FBOs (imports glGenFramebuffers)
  cartManagesFBOs = wasmImports.some(i =>
    (i.module === 'gl' || i.module === 'env') && i.kind === 'function' && i.name === 'glGenFramebuffers');
  // For SDL-only GL carts, defer context creation until after SDL window exists
  // so we can use the window surface (zero-copy) instead of pbuffer (readPixels)
  glUseWindowSurface = cartUsesGL && videoMode === 'sdl';
  if (cartUsesGL && !glUseWindowSurface) {
    const initW = preferredWidth || 320;
    const initH = preferredHeight || 240;
    if (!gl.createContext(initW, initH)) {
      console.error('Failed to create GL context');
      process.exit(1);
    }
  }
}

// Initialize subsystems
// GL carts and HW-rendered libretro cores need software SDL renderer (accelerated renderer conflicts with EGL context)
// Exception: window surface mode uses SDL's opengl window directly
// Window surface GL carts: scale=1 since EGL surface matches native window pixels (not SDL scaled)
const hwLibretroCores = ['mupen64plus_next', 'parallel_n64'];
const needsGL = cartUsesGL || (system && hwLibretroCores.includes(system.core));
const videoOutput = new VideoOutput({ video: videoMode, aspectMode, system: system.system, scale: glUseWindowSurface ? 1 : sdlScale, accelerated: !needsGL || glUseWindowSurface, initWidth: preferredWidth, initHeight: preferredHeight, fullscreen, opengl: glUseWindowSurface, shader: shaderPreset });
await videoOutput.init();

// For SDL-only GL carts, create EGL context using the SDL window's native handle
// Cart renders to FBO at its native resolution; we blit to window surface with letterboxing
let glSurfaceW = 0;  // current window surface size (updates on resize)
let glSurfaceH = 0;
let glFBOW = 0;      // FBO size (fixed at cart resolution)
let glFBOH = 0;
let glFBO = 0;
if (glUseWindowSurface) {
  const sdlWindow = videoOutput.getSDLWindow();
  const nativeGL = sdlWindow.native?.gl;
  if (!nativeGL) {
    console.error('SDL window has no native GL handle');
    process.exit(1);
  }
  glSurfaceW = sdlWindow.width;
  glSurfaceH = sdlWindow.height;
  if (!gl.createContext(glSurfaceW, glSurfaceH, { nativeWindow: nativeGL })) {
    console.error('Failed to create GL window surface context');
    process.exit(1);
  }
  // Disable vsync — our game loop handles frame pacing
  if (gl.setSwapInterval) {
    gl.setSwapInterval(0);
  }
  dlog(`[gl] Window surface: ${glSurfaceW}x${glSurfaceH}`);

  glNoFBORedirect = !!process.env.NO_FBO_REDIRECT;
  if (glNoFBORedirect) {
    process.env.RETROEMU_DEBUG && console.error('[gl] NO_FBO_REDIRECT: cart renders directly to window surface');
  }

  // Create FBO at cart resolution — cart renders here, we blit to window surface
  // This allows resize/letterbox and isolates the cart from the window surface
  if (!glNoFBORedirect) {
  const GL_TEXTURE_2D = 0x0DE1, GL_RGBA = 0x1908, GL_UNSIGNED_BYTE = 0x1401;
  const GL_FRAMEBUFFER = 0x8D40, GL_COLOR_ATTACHMENT0 = 0x8CE0;
  const GL_RENDERBUFFER = 0x8D41, GL_DEPTH24_STENCIL8 = 0x88F0;
  const GL_DEPTH_STENCIL_ATTACHMENT = 0x821A;
  const GL_NEAREST = 0x2600, GL_CLAMP_TO_EDGE = 0x812F;

  glFBOW = glSurfaceW;
  glFBOH = glSurfaceH;

  glFBO = new Uint32Array(1);
  gl.glGenFramebuffers(1, glFBO);
  glFBO = glFBO[0];

  const texIds = new Uint32Array(1);
  gl.glGenTextures(1, texIds);
  gl.glBindTexture(GL_TEXTURE_2D, texIds[0]);
  gl.glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, glSurfaceW, glSurfaceH, 0, GL_RGBA, GL_UNSIGNED_BYTE, null);
  gl.glTexParameteri(GL_TEXTURE_2D, 0x2801, GL_NEAREST);
  gl.glTexParameteri(GL_TEXTURE_2D, 0x2800, GL_NEAREST);
  gl.glTexParameteri(GL_TEXTURE_2D, 0x2802, GL_CLAMP_TO_EDGE);
  gl.glTexParameteri(GL_TEXTURE_2D, 0x2803, GL_CLAMP_TO_EDGE);

  gl.glBindFramebuffer(GL_FRAMEBUFFER, glFBO);
  gl.glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texIds[0], 0);

  const rbIds = new Uint32Array(1);
  gl.glGenRenderbuffers(1, rbIds);
  gl.glBindRenderbuffer(GL_RENDERBUFFER, rbIds[0]);
  gl.glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH24_STENCIL8, glSurfaceW, glSurfaceH);
  gl.glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_STENCIL_ATTACHMENT, GL_RENDERBUFFER, rbIds[0]);

  const status = gl.glCheckFramebufferStatus(GL_FRAMEBUFFER);
  dlog(`[gl] FBO redirect: ${glSurfaceW}x${glSurfaceH} (status=0x${status.toString(16)})`);

  // Redirect cart's bindFramebuffer(target, 0) → our FBO
  const _origBindFB = gl.glBindFramebuffer;
  let _lastDrawFBO = glFBO;  // track which FBO is the draw target
  let _cartBlittedToFBO = false; // set when cart blits to our FBO
  gl.glBindFramebuffer = (target, fb) => {
    const actual = fb === 0 ? glFBO : fb;
    if (target === 0x8D40) _lastDrawFBO = actual; // GL_FRAMEBUFFER sets both
    else if (target === 0x8CA9) _lastDrawFBO = actual; // GL_DRAW_FRAMEBUFFER
    _origBindFB.call(gl, target, actual);
  };
  gl._origBindFramebuffer = _origBindFB.bind(gl);

  // Suppress color clear on our FBO after cart has blitted content to it.
  // OpenArena's RB_SwapBuffers clears "default FB" at end-of-frame, wiping
  // the 3D scene that was just blitted. The 2D (HUD) is drawn after the clear
  // so it survives, but the 3D content gets lost. Fix: skip the color clear
  // on our FBO when the cart just blitted to it (the 3D content is fresh).
  const _origClear = gl.glClear;
  gl._origClear = _origClear.bind(gl);
  let _clearSuppressCount = 0;
  gl.glClear = (mask) => {
    if (_cartBlittedToFBO && _lastDrawFBO === glFBO && (mask & 0x4000)) {
      // Cart is clearing our FBO's color buffer after a blit — suppress it.
      _clearSuppressCount++;
      if (_clearSuppressCount <= 5) {
        dlog(`[fbo-fix] suppressed glClear(0x${mask.toString(16)}) on our FBO (count=${_clearSuppressCount})`);
      }
      const remaining = mask & ~0x4000; // keep depth/stencil clears if any
      if (remaining) _origClear.call(gl, remaining);
      return;
    }
    _origClear.call(gl, mask);
  };

  // Track when cart blits to our FBO + one-time diagnostic
  const _origBlitFB = gl.glBlitFramebuffer;
  let _blitDiagDone = false;
  let _blitCount = 0;
  gl.glBlitFramebuffer = (srcX0, srcY0, srcX1, srcY1, dstX0, dstY0, dstX1, dstY1, mask, filter) => {
    if (_lastDrawFBO === glFBO && (mask & 0x4000)) {
      _cartBlittedToFBO = true;
      _blitCount++;
      // One-time: read source FBO content before blit (after 300 blits ~ 5s of gameplay)
      if (!_blitDiagDone && _blitCount > 300) {
        _blitDiagDone = true;
        // Read from the READ_FRAMEBUFFER (should be render FBO 2)
        const dW = srcX1, dH = srcY1;
        const px = Buffer.alloc(dW * dH * 4);
        gl.glReadPixels(0, 0, dW, dH, 0x1908, 0x1401, px);
        let nonBlack = 0;
        for (let i = 0; i < px.length; i += 4) {
          if (px[i] > 5 || px[i+1] > 5 || px[i+2] > 5) nonBlack++;
        }
        dlog(`[blit-diag] Source FBO content BEFORE blit: ${nonBlack}/${dW*dH} non-black (${(100*nonBlack/(dW*dH)).toFixed(1)}%)`);
      }
    }
    _origBlitFB.call(gl, srcX0, srcY0, srcX1, srcY1, dstX0, dstY0, dstX1, dstY1, mask, filter);
  };
  gl._origBlitFramebuffer = _origBlitFB.bind(gl);
  // Reset flag each frame (called from game loop after host blit)
  gl._resetBlitFlag = () => { _cartBlittedToFBO = false; };

  // Intercept glDrawBuffer/glReadBuffer: translate GL_BACK → GL_COLOR_ATTACHMENT0
  // when our FBO is bound (FBOs don't support GL_BACK)
  if (gl.glDrawBuffer) {
    const _origDrawBuffer = gl.glDrawBuffer;
    gl.glDrawBuffer = (buf) => {
      _origDrawBuffer.call(gl, buf === 0x0405 ? 0x8CE0 : buf); // GL_BACK → GL_COLOR_ATTACHMENT0
    };
  }
  if (gl.glReadBuffer) {
    const _origReadBuffer = gl.glReadBuffer;
    gl.glReadBuffer = (buf) => {
      _origReadBuffer.call(gl, buf === 0x0405 ? 0x8CE0 : buf); // GL_BACK → GL_COLOR_ATTACHMENT0
    };
  }
  gl._origBlitFramebuffer = _origBlitFB.bind(gl);

  gl.glViewport(0, 0, glFBOW, glFBOH);
  } // end if (!glNoFBORedirect)
}
// Shaders and CPU filters are separate subsystems and RetroArch does not
// combine them either. Say so rather than silently dropping one.
if (shaderPreset && videoFilter && videoFilter !== 'none') {
  console.error(`[shader] --shader overrides --video-filter ${videoFilter} (GPU shader vs CPU filter)`);
  videoFilter = 'none';
}
videoOutput.setFilter(videoFilter);
videoOutput.setFrameSkip(frameSkip);
videoOutput.setContrast(contrast);
videoOutput.setSymbols(symbols);
videoOutput.setColors(colors);
videoOutput.setFgOnly(fgOnly);
videoOutput.setDither(dither);

const audioBridge = new AudioBridge();
// NOTE: SDL window must be created (by VideoOutput.init) BEFORE InputManager
// so that gamepad-node's controller init doesn't break window events.
// Always hand InputManager retroemu's shared SDL — videoOutput.getSDL() is null in
// terminal mode (no SDL renderer), which used to let gamepad-node fall back to its own
// @kmamal/sdl import (a different instance on a duplicated tree → dead controller).
const sdlInstance = videoOutput.getSDL() || SDL;
const inputManager = new InputManager({ disableGamepad, debugInput, sdl: sdlInstance, remap: inputRemap });
// Register SDL window for keyboard input when SDL video is active
const sdlWindow = videoOutput.getSDLWindow();
if (sdlWindow) {
  inputManager.setSDLWindow(sdlWindow);
  // Track window resizes for GL surface updates
  if (glUseWindowSurface) {
    sdlWindow.on('resize', (e) => {
      glSurfaceW = e.width;
      glSurfaceH = e.height;
    });
  }
}
const saveManager = new SaveManager(saveDir);

// Enter alternate screen buffer, hide cursor (only for terminal modes)
const useTerminal = videoMode === 'terminal' || videoMode === 'both';
if (useTerminal) {
  process.stdout.write('\x1b[?1049h\x1b[?25l');
}

// Clean shutdown handler
let shuttingDown = false;
let host = null;
let controlChannel = null;
let remoteHost = null;
let cartHost = null;
let cartRunning = false;
let jsGameSession = null;
let jsGameRunning = false;
let activeBezel = null;
let activeBezelNormalAspect = null;
let activeBezelWatcher = null;
let activeBezelReloadTimer = null;
videoOutput.onDisplayChange = (width, height) => activeBezel?.setDisplay?.(width, height);
let _realGetGamepads = null; // real SDL getGamepads, saved before createHostSession clobbers navigator

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  // Push the final state to the frontend (resume-on-next-launch) before
  // tearing anything down.
  if (controlChannel) {
    try { await controlChannel.sendAutosave(); } catch { /* parent may be gone */ }
  }

  if (cartHost) {
    cartRunning = false;
    // Save cart data
    const saveData = cartHost.getSaveData();
    if (saveData) {
      const cartName = basename(romPath, '.wasc');
      await saveManager.writeCartSave(cartName, saveData);
    }
    cartHost.destroy();
  }

  if (jsGameSession) {
    jsGameRunning = false;
    try { jsGameSession.destroy(); } catch {}
  }

  if (host) {
    activeBezel?.shutdown();
    activeBezelWatcher?.close();
    await host.shutdown();
  }

  try {
    inputManager.destroy();
  } catch {
    // Ignore SDL controller cleanup errors
  }

  videoOutput.destroy();

  // Restore terminal (only if we modified it)
  if (useTerminal) {
    process.stdout.write('\x1b[?1049l\x1b[?25h');
  }
  process.exit(0);
}

async function loadActiveBezel() {
  const { ActiveBezelRuntime } = await import('active-bezel/runtime');
  const next = await ActiveBezelRuntime.create({
    packagePath: activeBezelPath,
    host,
    romBytes: romInfo.data,
    platform: system.system,
    config: activeBezel?.config?.values ?? activeBezelConfig,
    force: activeBezelForce,
    /*
     * The bezel's input view is the PHYSICAL pad, never the overridden one:
     * the core polls InputManager.getState (override applied), while a
     * pre_frame swap that read its own output back would re-swap every
     * frame. setOverride/clearOverrides route to the same manager the core
     * reads, which is what makes an override real.
     */
    inputManager: {
      getState: (p, d, i, id) => inputManager.getPhysicalState(p, d, i, id),
      setOverride: (p, d, i, id, v) => inputManager.setOverride(p, d, i, id, v),
      clearOverrides: () => inputManager.clearOverrides(),
    },
    allowGpu: !needsGL,
    outputWidth: preferredWidth || 1920,
    outputHeight: preferredHeight || 1080,
  });
  const previous = activeBezel;
  if (!previous) activeBezelNormalAspect = videoOutput.displayAspectRatio;
  activeBezel = next;
  // ABI-2 pre_frame: run the guest hook before every core frame. Installed
  // unconditionally (an ASSETS_RELOADED reboot can add the hook later);
  // preFrame early-returns when the script defines none.
  host.beforeFrame = (n) => activeBezel?.preFrame?.(n);
  videoOutput.setAspectRatio(16 / 9);
  videoOutput.setFrameProcessor(
    (rgba, width, height, frame) => activeBezel.processFrame(rgba, width, height, frame),
    { effectScope: activeBezel.package.manifest.pictureEffect },
  );
  previous?.shutdown();
  dlog(`[active-bezel] ${activeBezel.package.manifest.name} (${activeBezel.match.level})`);
  return activeBezel.status();
}

function disableActiveBezel() {
  activeBezel?.shutdown();
  activeBezel = null;
  // Unhook pre_frame and drop any override staged for the next frame — a
  // disabled bezel must stop shaping the game immediately.
  host.beforeFrame = null;
  inputManager.clearOverrides?.();
  videoOutput.setFrameProcessor(null);
  if (activeBezelNormalAspect) videoOutput.setAspectRatio(activeBezelNormalAspect);
  activeBezelNormalAspect = null;
  return { enabled: false };
}

function watchActiveBezel() {
  if (!activeBezelDev || !activeBezelPath || activeBezelWatcher) return;
  activeBezelWatcher = watchFs(activeBezelPath, { persistent: false }, () => {
    clearTimeout(activeBezelReloadTimer);
    activeBezelReloadTimer = setTimeout(async () => {
      try {
        await loadActiveBezel();
        activeBezel.event?.(6);
        console.error('[active-bezel] reloaded');
      } catch (err) {
        console.error(`[active-bezel] reload rejected; keeping previous instance: ${err.message}`);
      }
    }, 75);
  });
  dlog(`[active-bezel] watching ${statSync(activeBezelPath).isDirectory() ? 'directory' : 'archive'} for changes`);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => {
  // Ensure terminal is restored even on unexpected exit (only if we modified it)
  if (useTerminal) {
    process.stdout.write('\x1b[?1049l\x1b[?25h');
  }
});

// Hotkeys via stdin
if (process.stdin.isTTY) {
  process.stdin.on('data', async (key) => {
    // ESC = quit
    if (key === '\x1b' && key.length === 1) {
      await shutdown();
    }
    // Libretro-specific hotkeys
    if (!isCart) {
      // F5 = save state (ESC [ 1 5 ~)
      if (key === '\x1b[15~') {
        await host.saveState(0);
      }
      // F7 = load state (ESC [ 1 8 ~)
      if (key === '\x1b[18~') {
        await host.loadState(0);
        activeBezel?.event?.(2);
      }
      // F1 = reset (ESC [ 1 1 ~)
      if (key === '\x1b[11~') {
        host.reset();
        activeBezel?.event?.(1);
      }
    }
  });
}

// Start
try {
  if (controlMode) {
    const { ControlChannel } = await import('../src/control/ControlChannel.js');
    controlChannel = new ControlChannel({
      getHost: () => host,
      videoOutput,
      inputManager,
      audioBridge,
      shutdown,
      romPath,
      system,
      ffSpeed,
      rewindEnabled,
      getActiveBezel: () => activeBezel,
      reloadActiveBezel: () => loadActiveBezel(),
      disableActiveBezel,
    });
  }
  if (isCart) {
    await startCart();
  } else if (isJsGame) {
    await startJsGame();
  } else {
    host = new LibretroHost({
      videoOutput,
      audioBridge,
      inputManager,
      saveManager,
      coreOptions,
    });
    await host.loadAndStart(romInfo.romPath, {
      saveDir, romData: romInfo.data, systemDir: biosDir ?? undefined,
    });
    if (activeBezelPath === 'discover') {
      const sidecar = join(dirname(romPath),
        basename(romPath, extname(romPath)) + '.ab');
      if (existsSync(sidecar)) {
        activeBezelPath = sidecar;
      } else {
        console.error(`[active-bezel] no sidecar found at ${sidecar}`);
        activeBezelPath = null;
      }
    }
    if (activeBezelPath) {
      try {
        await loadActiveBezel();
        watchActiveBezel();
      } catch (err) {
        // An optional enhancement must never prevent the ROM from launching.
        // Romdeck receives the null status over IPC and can explain the
        // package error while the ordinary game remains playable.
        console.error(`[active-bezel] disabled at launch: ${err.message}`);
        activeBezel = null;
        videoOutput.setFrameProcessor(null);
      }
    }
    if (cheatList?.length) {
      const applied = host.setCheats(cheatList);
      dlog(`[cheats] applied ${applied}`);
    }
    if (controlChannel) controlChannel.attachHost(host);

    // In-game overlay menu (SDL modes only): Start+Select or ESC
    if (videoMode === 'sdl' || videoMode === 'both') {
      const { Overlay } = await import('../src/control/Overlay.js');
      const overlay = new Overlay({
        getHost: () => host,
        videoOutput,
        inputManager,
        shutdown,
        getActiveBezel: () => activeBezel,
        disableActiveBezel,
        romPath: romInfo.romPath,
        saveDir,
      });
      inputManager.onMenu = () => overlay.toggle();
      inputManager.menuKeyRouter = (name) => overlay.key(name);
      if (controlChannel) controlChannel.setOverlay(overlay);
    }

    // --host-remote without a frontend: start hosting and print the code.
    if (hostRemote) {
      const { RemoteHost } = await import('../src/net/RemotePlay.js');
      remoteHost = new RemoteHost({ videoOutput, inputManager, audioBridge, log: (m) => console.log(m) });
      const info = await remoteHost.start();
      console.log(`\n  Share code: ${info.code}`);
      console.log('  (base24 — no 0/O, 1/I/L, 2/Z, 5/S or 8/B, so it reads aloud cleanly)');
      console.log(`  Player 2:   npx retroemu --join ${info.code}`);
      console.log(`  Spectators: npx retroemu --watch ${info.code}\n`);
    }
  }
  if (controlChannel) controlChannel.sendReady();
} catch (err) {
  if (useTerminal) {
    process.stdout.write('\x1b[?1049l\x1b[?25h');
  }
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

// --- WASM Cart runner ---

async function startCart() {
  cartHost = new CartHost();

  // Load existing save data if available
  const cartName = basename(romPath, '.wasc');
  const existingSave = await saveManager.readCartSave(cartName);

  const loadOptions = {
    saveData: existingSave,
    preferredWidth,
    preferredHeight,
    audioSampleRate: 48000,
  };

  if (cartUsesGL) {
    // Re-assert our EGL context after SDL init
    gl.makeCurrent();
    // Wrap native-gles with WebGL2RenderingContext API (webgl_imports.js expects WebGL2)
    const ctxW = glUseWindowSurface ? glSurfaceW : (preferredWidth || 320);
    const ctxH = glUseWindowSurface ? glSurfaceH : (preferredHeight || 240);
    loadOptions.glBackend = new WebGL2RenderingContext(gl, ctxW, ctxH);
    loadOptions.nativeGL = gl;
  }

  await cartHost.load(romPath, loadOptions);

  const info = cartHost.getInfo();
  videoOutput.setAspectRatio(info.width / info.height);

  // Log gpu_api for debugging
  if (info.gpuApi > 0) {
    dlog(`[cart] gpu_api=${info.gpuApi}`);
  }

  if (glUseWindowSurface) {
    gl.makeCurrent();
    if (!glNoFBORedirect) {
      gl._origBindFramebuffer(0x8D40, glFBO);
      gl.glViewport(0, 0, glFBOW, glFBOH);
    } else {
      gl.glViewport(0, 0, glSurfaceW, glSurfaceH);
    }
  } else {
    // Resize SDL window — use preferred res if set, otherwise cart's resolution
    videoOutput.resizeWindow(preferredWidth || info.width, preferredHeight || info.height);

    // Resize GL context to match cart's actual dimensions
    if (cartUsesGL && (info.width !== 320 || info.height !== 240)) {
      gl.resizeContext(info.width, info.height);
      gl.makeCurrent();
      gl.glViewport(0, 0, info.width, info.height);
    }
  }

  // Init audio — use cart's sample rate and format, host adapts
  const audioFormat = cartHost.info?.audioIsF32 ? 'f32' : 's16';
  const audioRate = cartHost.info?.audioSampleRate || 48000;
  await audioBridge.init(audioRate, audioFormat);

  cartRunning = true;
  const targetMs = uncapped ? 0 : (1000 / 60); // 60 FPS or uncapped

  let _lastFrameTime = performance.now();
  let _fpsFrameCount = 0;
  let _fpsLastReport = performance.now();
  let _glReadTotal = 0;
  let _glFlipTotal = 0;
  let _renderTotal = 0;

  function gameLoop() {
    if (!cartRunning) return;

    const now = performance.now();
    const elapsed = now - _lastFrameTime;

    if (uncapped || elapsed >= targetMs) {
      // Drift compensation: preserve fractional time to prevent accumulation
      _lastFrameTime = uncapped ? now : now - (elapsed % targetMs);

      // Poll input (handles Start+Select exit combo)
      inputManager.poll();

      // Forward raw keyboard to wasmcart keyboard ABI
      inputManager.updateCartKeyboard(cartHost);

      // Map gamepad-node W3C gamepads to wasmcart pad format
      const pads = mapGamepads();

      // Run one frame
      const result = cartHost.runFrame(pads);

      // For GL carts: display the rendered frame
      if (cartUsesGL) {
        if (glUseWindowSurface) {
          const _t0 = performance.now();
          if (glNoFBORedirect) {
            // One-time capture before swap
            gl._totalFrames = (gl._totalFrames || 0) + 1;
            if (gl._totalFrames === 600) {
              gl.glBindFramebuffer(0x8D40, 0); // default FB
              const dW = glSurfaceW, dH = glSurfaceH;
              const px = Buffer.alloc(dW * dH * 4);
              gl.glReadPixels(0, 0, dW, dH, 0x1908, 0x1401, px);
              let nonBlack = 0;
              for (let i = 0; i < px.length; i += 4) {
                if (px[i] > 5 || px[i+1] > 5 || px[i+2] > 5) nonBlack++;
              }
              dlog(`[nofbo-dump] FB0 content: ${nonBlack}/${dW*dH} non-black pixels (${(100*nonBlack/(dW*dH)).toFixed(1)}%)`);
              // Write PPM
              const rgb = Buffer.alloc(dW * dH * 3);
              for (let y = 0; y < dH; y++) {
                const srcRow = (dH - 1 - y) * dW * 4;
                const dstRow = y * dW * 3;
                for (let x = 0; x < dW; x++) {
                  rgb[dstRow + x*3] = px[srcRow + x*4];
                  rgb[dstRow + x*3+1] = px[srcRow + x*4+1];
                  rgb[dstRow + x*3+2] = px[srcRow + x*4+2];
                }
              }
              writeFileSync('/tmp/oa_nofbo.ppm', Buffer.concat([Buffer.from(`P6\n${dW} ${dH}\n255\n`), rgb]));
              process.env.RETROEMU_DEBUG && console.error('[nofbo-dump] Wrote /tmp/oa_nofbo.ppm');
            }
            // Direct mode: cart rendered to window surface, just swap
            gl.swapBuffers();
          } else {
            // Blit FBO → window surface with letterboxing, then swap
            gl._origBindFramebuffer(0x8CA8, glFBO);  // READ_FRAMEBUFFER
            gl._origBindFramebuffer(0x8CA9, 0);       // DRAW_FRAMEBUFFER
            gl.glDisable(0x0C11); // GL_SCISSOR_TEST
            gl.glViewport(0, 0, glSurfaceW, glSurfaceH);
            gl.glClearColor(0, 0, 0, 1);
            gl._origClear(0x4000);   // GL_COLOR_BUFFER_BIT — use orig to bypass interception
            gl._origBlitFramebuffer(
              0, 0, glFBOW, glFBOH,
              0, 0, glSurfaceW, glSurfaceH,
              0x4000, 0x2601      // COLOR_BUFFER_BIT, LINEAR
            );
            gl.swapBuffers();
            if (gl._resetBlitFlag) gl._resetBlitFlag();
            // Restore FBO + viewport for next frame
            gl._origBindFramebuffer(0x8D40, glFBO);  // FRAMEBUFFER
            gl.glViewport(0, 0, glFBOW, glFBOH);
          }
          const _t1 = performance.now();
          _renderTotal += (_t1 - _t0);
        } else {
          // Pbuffer mode: readback is decoupled — see termReadbackInterval below
          // Just store current dimensions for the readback timer
          startCart._glW = result.width;
          startCart._glH = result.height;
        }
      } else {
        // Send framebuffer to video output (XRGB8888)
        // Send framebuffer to video output (XRGB8888)
        videoOutput.onCartFrame(result.framebuffer, result.width, result.height);
      }

      _fpsFrameCount++;
      const _fpsNow = performance.now();
      if (_fpsNow - _fpsLastReport >= 5000) {
        const elapsed = (_fpsNow - _fpsLastReport) / 1000;
        const fps = (_fpsFrameCount / elapsed).toFixed(1);
        if (cartUsesGL && glUseWindowSurface) {
          dlog(`[perf] ${fps} fps | swapBuffers=${(_renderTotal/_fpsFrameCount).toFixed(2)}ms`);
        } else if (cartUsesGL) {
          dlog(`[perf] ${fps} fps | glRead=${(_glReadTotal/_fpsFrameCount).toFixed(2)}ms flip=${(_glFlipTotal/_fpsFrameCount).toFixed(2)}ms render=${(_renderTotal/_fpsFrameCount).toFixed(2)}ms`);
        } else {
          dlog(`[perf] ${fps} fps`);
        }
        _fpsFrameCount = 0;
        _fpsLastReport = _fpsNow;
        _glReadTotal = 0;
        _glFlipTotal = 0;
        _renderTotal = 0;
      }

      // Queue audio
      if (result.audio && result.audio.length > 0) {
        const buffer = Buffer.from(result.audio.buffer, result.audio.byteOffset, result.audio.byteLength);
        audioBridge.device.enqueue(buffer);
      }
    }

    // Frame pacing: use setTimeout for coarse timing, setImmediate for tight timing
    if (uncapped) {
      setImmediate(gameLoop);
    } else {
      const remaining = targetMs - (performance.now() - _lastFrameTime);
      if (remaining > 2) {
        setTimeout(gameLoop, Math.floor(remaining) - 1);
      } else {
        setImmediate(gameLoop);
      }
    }
  }

  gameLoop();

  // Decoupled GL pbuffer readback for terminal display.
  // Runs at --term-fps (default 30) independently of the game loop,
  // so glReadPixels + flip + chafa don't slow down the cart.
  if (cartUsesGL && !glUseWindowSurface) {
    const termMs = 1000 / termFps;
    dlog(`[gl] Terminal readback decoupled at ${termFps} fps (${termMs.toFixed(0)}ms)`);
    setInterval(() => {
      if (!cartRunning) return;
      const w = startCart._glW;
      const h = startCart._glH;
      if (!w || !h) return;

      const GL_RGBA = 0x1908, GL_UNSIGNED_BYTE = 0x1401;
      if (!startCart._glPixels || startCart._glPixels.length !== w * h * 4) {
        startCart._glPixels = new Uint8Array(w * h * 4);
      }
      const _t0 = performance.now();
      gl.glFinish();
      gl.glReadPixels(0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, startCart._glPixels);
      const _t1 = performance.now();

      // GL is bottom-up, flip vertically
      const rowBytes = w * 4;
      if (!startCart._flipped || startCart._flipped.length !== w * h * 4) {
        startCart._flipped = new Uint8Array(w * h * 4);
      }
      const src = startCart._glPixels;
      const dst = startCart._flipped;
      for (let y = 0; y < h; y++) {
        const srcOff = (h - 1 - y) * rowBytes;
        const dstOff = y * rowBytes;
        dst.set(src.subarray(srcOff, srcOff + rowBytes), dstOff);
      }
      const _t2 = performance.now();
      videoOutput.onCartFrameRGBA(dst, w, h);
      const _t3 = performance.now();
      _glReadTotal += (_t1 - _t0);
      _glFlipTotal += (_t2 - _t1);
      _renderTotal += (_t3 - _t2);
    }, termMs);
  }
}

// Map W3C gamepads → jsgame standard-name pad objects (rungame's synthetic navigator
// speaks button names, not a bitmask). d-pad from buttons 12-15, face from 0-3.
function mapJsGamePads() {
  // Use the REAL SDL getGamepads captured before the session clobbered navigator (see
  // startJsGame). Falling back to navigator.getGamepads would read the session's own
  // injected pads → an empty feedback loop → no controller input.
  const getPads = _realGetGamepads
    || (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function' ? navigator.getGamepads.bind(navigator) : null);
  const w3c = getPads ? getPads() : [];
  // --debug-input: dump what the REAL SDL pad reports so we can see if buttons register.
  if (debugInput) {
    const gp0 = w3c[0];
    if (gp0 && gp0.connected) {
      const pressed = gp0.buttons.map((b, i) => (b?.pressed ? i : -1)).filter((i) => i >= 0);
      const axes = gp0.axes.map((v) => v.toFixed(2)).join(',');
      console.error(`[jsg-input] realGetGamepads=${!!_realGetGamepads} pad='${gp0.id}' pressed=[${pressed.join(',')}] axes=[${axes}]`);
    } else {
      console.error(`[jsg-input] realGetGamepads=${!!_realGetGamepads} pads=${w3c.length} pad0=${gp0 ? 'not-connected' : 'null'}`);
    }
  }
  const pads = [];
  for (let i = 0; i < 4; i++) {
    const gp = w3c[i];
    if (!gp || !gp.connected) { pads.push({}); continue; }
    const b = gp.buttons;
    pads.push({
      a: !!b[0]?.pressed, b: !!b[1]?.pressed, x: !!b[2]?.pressed, y: !!b[3]?.pressed,
      l1: !!b[4]?.pressed, r1: !!b[5]?.pressed, l2: !!b[6]?.pressed, r2: !!b[7]?.pressed,
      select: !!b[8]?.pressed, start: !!b[9]?.pressed,
      up: !!b[12]?.pressed, down: !!b[13]?.pressed, left: !!b[14]?.pressed, right: !!b[15]?.pressed,
      lx: gp.axes?.[0] || 0, ly: gp.axes?.[1] || 0, rx: gp.axes?.[2] || 0, ry: gp.axes?.[3] || 0,
    });
  }
  return pads;
}

// Run a jsgame (.jsgame/.jsg) headless via rungame's createHostSession and pump its
// frames into retroemu's OWN video pipeline (terminal chafa / SDL / both) — the same
// onCartFrameRGBA path a GL/cart frame uses. So a JS web game renders as ANSI art in the
// terminal, exactly like every other retroemu system. rungame's realm needs
// --experimental-vm-modules; cli.js self-re-execs with it (see the top of this file).
async function startJsGame() {
  // createHostSession OVERRIDES globalThis.navigator.getGamepads to return its own
  // host-INJECTED pads (that's how it feeds input to the game — via setInput). But that
  // clobbers the SDL-backed getGamepads our InputManager installed, so if we read
  // navigator.getGamepads() afterward we'd get the (empty) injected pads, not the real
  // controllers. Capture the REAL SDL getGamepads BEFORE the session overrides it, and
  // read physical controllers through that saved reference (see mapJsGamePads).
  _realGetGamepads = (typeof navigator !== 'undefined' && navigator.getGamepads)
    ? navigator.getGamepads.bind(navigator)
    : null;

  jsGameSession = await createJsGameSession(romPath, {
    width: preferredWidth || 640,
    height: preferredHeight || 480,
    sdl: SDL, // share retroemu's SDL instance so the realm's controller/audio use the same one
  });

  const cw = jsGameSession.canvas.width, ch = jsGameSession.canvas.height;
  videoOutput.setAspectRatio(cw / ch);
  videoOutput.resizeWindow(cw, ch);

  jsGameRunning = true;
  const targetMs = uncapped ? 0 : (1000 / 60);
  let _lastFrameTime = performance.now();
  let _stepping = false;

  async function gameLoop() {
    if (!jsGameRunning) return;
    const now = performance.now();
    const elapsed = now - _lastFrameTime;

    if (!_stepping && (uncapped || elapsed >= targetMs)) {
      _lastFrameTime = uncapped ? now : now - (elapsed % targetMs);
      inputManager.poll(); // Start+Select exit combo
      jsGameSession.setInput(mapJsGamePads());

      _stepping = true;
      await jsGameSession.stepFrame(); // async: yields for the game's async work
      _stepping = false;

      const frame = jsGameSession.readFrame(); // { data (RGBA), width, height }
      const buf = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
      videoOutput.onCartFrameRGBA(buf, frame.width, frame.height);
    }

    if (uncapped) {
      setImmediate(gameLoop);
    } else {
      const remaining = targetMs - (performance.now() - _lastFrameTime);
      if (remaining > 2) setTimeout(gameLoop, Math.floor(remaining) - 1);
      else setImmediate(gameLoop);
    }
  }
  gameLoop();
}

function mapGamepads() {
  const pads = [];
  let hasW3C = typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function';
  const w3cPads = hasW3C ? navigator.getGamepads() : [];

  // One-time debug: log how many gamepads found
  if (!mapGamepads._countLogged) {
    mapGamepads._countLogged = true;
    const connected = w3cPads.filter(g => g && g.connected).length;
    dlog(`GAMEPAD: hasW3C=${hasW3C}, total=${w3cPads.length}, connected=${connected}`);
  }

  for (let i = 0; i < 4; i++) {
    const gp = w3cPads[i];

    let buttons = 0;
    let leftX = 0, leftY = 0, rightX = 0, rightY = 0;
    let leftTrigger = 0, rightTrigger = 0;
    let connected = false;

    if (gp && gp.connected) {
      connected = true;
      // W3C button index → wasmcart BUTTON bitmask
      if (gp.buttons[0]?.pressed) buttons |= BUTTON.A;      // South
      if (gp.buttons[1]?.pressed) buttons |= BUTTON.B;      // East
      if (gp.buttons[2]?.pressed) buttons |= BUTTON.X;      // West
      if (gp.buttons[3]?.pressed) buttons |= BUTTON.Y;      // North
      if (gp.buttons[4]?.pressed) buttons |= BUTTON.L;      // L1
      if (gp.buttons[5]?.pressed) buttons |= BUTTON.R;      // R1
      if (gp.buttons[6]?.pressed) buttons |= (1 << 14);     // LT as digital button bit 14
      if (gp.buttons[7]?.pressed) buttons |= (1 << 15);     // RT as digital button bit 14
      if (gp.buttons[8]?.pressed) buttons |= BUTTON.SELECT;
      if (gp.buttons[9]?.pressed) buttons |= BUTTON.START;
      if (gp.buttons[10]?.pressed) buttons |= BUTTON.L3;
      if (gp.buttons[11]?.pressed) buttons |= BUTTON.R3;
      if (gp.buttons[12]?.pressed) buttons |= BUTTON.UP;
      if (gp.buttons[13]?.pressed) buttons |= BUTTON.DOWN;
      if (gp.buttons[14]?.pressed) buttons |= BUTTON.LEFT;
      if (gp.buttons[15]?.pressed) buttons |= BUTTON.RIGHT;

      // Analog sticks: W3C float (-1..1) → int16 (-32768..32767)
      const toI16 = (v) => Math.round(Math.max(-1, Math.min(1, v || 0)) * 32767);
      leftX = toI16(gp.axes[0]);
      leftY = toI16(gp.axes[1]);
      rightX = toI16(gp.axes[2]);
      rightY = toI16(gp.axes[3]);

      // Triggers: try button values first, fall back to axes
      // Auto-calibrate: some gamepads (e.g. 8BitDo) report 0.5-0.64 at rest
      const toU8 = (v) => Math.round(Math.max(0, Math.min(1, v || 0)) * 255);
      const gpIdx = gp._wcIdx = gp._wcIdx ?? i;
      if (!mapGamepads._triggerBaseline) mapGamepads._triggerBaseline = {};
      const rawLT = gp.buttons[6]?.value || 0;
      const rawRT = gp.buttons[7]?.value || 0;
      if (!mapGamepads._triggerBaseline[gpIdx]) {
        // Capture resting values on first read
        mapGamepads._triggerBaseline[gpIdx] = { left: rawLT, right: rawRT };
      }
      const bl = mapGamepads._triggerBaseline[gpIdx];
      const ltRange = Math.max(0.01, 1 - bl.left);
      const rtRange = Math.max(0.01, 1 - bl.right);
      leftTrigger = toU8(Math.max(0, rawLT - bl.left) / ltRange);
      rightTrigger = toU8(Math.max(0, rawRT - bl.right) / rtRange);

      // Debug: log full gamepad state once when any button is pressed
      if (!mapGamepads._debugged) {
        const anyPressed = gp.buttons.some(b => b?.pressed);
        if (anyPressed) {
          mapGamepads._debugged = true;
          debugInput && console.error('GAMEPAD DEBUG: id:', gp.id);
          debugInput && console.error('GAMEPAD DEBUG: axes count:', gp.axes.length, 'buttons count:', gp.buttons.length);
          for (let b = 0; b < gp.buttons.length; b++) {
            const btn = gp.buttons[b];
            if (btn && debugInput) console.error(`  btn[${b}]: pressed=${btn.pressed} value=${btn.value}`);
          }
          if (gp.axes.length > 0) {
            debugInput && console.error('GAMEPAD DEBUG: axes:', gp.axes.map((v, i) => `[${i}]=${v.toFixed(3)}`).join(' '));
          }
          if (bl.left > 0.01 || bl.right > 0.01) {
            debugInput && console.error('GAMEPAD DEBUG: trigger baseline calibration: LT=', bl.left.toFixed(3), 'RT=', bl.right.toFixed(3));
          }
        }
      }
      // Fallback to axes if button-based triggers gave zero
      if (!leftTrigger && gp.axes.length > 4 && gp.axes[4] != null) {
        leftTrigger = toU8((gp.axes[4] + 1) / 2);
      }
      if (!rightTrigger && gp.axes.length > 5 && gp.axes[5] != null) {
        rightTrigger = toU8((gp.axes[5] + 1) / 2);
      }
    }

    // Merge keyboard input into pad 0
    if (i === 0) {
      const kbButtons = inputManager.getKeyboardButtons();
      if (kbButtons) {
        buttons |= kbButtons;
        connected = true;
      }
    }

    let name = '';
    if (gp && gp.id) {
      name = gp.id;
      // If keyboard is also contributing to this pad, note both
      if (i === 0 && inputManager.getKeyboardButtons()) name += ' + Keyboard';
    } else if (i === 0 && connected) {
      name = 'Keyboard';
    }
    pads.push(connected ? { connected: true, buttons, leftX, leftY, rightX, rightY, leftTrigger, rightTrigger, name } : null);
  }

  return pads;
}

function printUsage() {
  console.log(`retroemu - Terminal retro game retroemulator`);
  console.log(``);
  console.log(`Usage: retroemu [options] <rom-file>`);
  console.log(``);
  console.log(`Options:`);
  console.log(`  --save-dir <dir>     Directory for save files (default: <rom-dir>/saves)`);
  console.log(`  --bios-dir <dir>     Directory holding BIOS/system ROMs (PCE-CD, ColecoVision)`);
  console.log(`  --core-option k=v    Set a libretro core option (repeatable),`);
  console.log(`                       e.g. --core-option fmsx_mode=MSX2`);
  console.log(`  --frame-skip <n>     Render every Nth frame to terminal (default: 2)`);
  console.log(`  --term-fps <n>       Terminal readback rate for GL carts (default: 30)`);
  console.log(`  --contrast <n>       Contrast boost, 1.0=normal, 1.5=more contrast (default: 1.0)`);
  console.log(``);
  console.log(`Video output:`);
  console.log(`  --video <mode>       Output mode: terminal, sdl, both (default: terminal)`);
  console.log(`  --aspect <mode>      Picture shape: tv (the physical display the system was
                       built for: 4:3 CRT for consoles, the LCD's own shape for
                       handhelds), native (square pixels), core (core-reported)
                       (default: tv)`);
  console.log(`  --scale <n>          SDL window scale factor (default: 2)`);
  console.log(`  --res <WxH>          Preferred resolution for WASM carts (e.g. 800x600, 1280x720)`);
  console.log(`  -f, --fullscreen     Start SDL window in fullscreen mode`);
  console.log(`  --uncapped           Run as fast as the host allows (no 60 FPS cap)`);
  console.log(`  --control            Enable the IPC session channel (for frontends; spawn with stdio 'ipc')`);
  console.log(`  --input-map <json>   Controller remap: inline JSON or @file (per-device bindings + port order)`);
  console.log(`  --shader <preset>    RetroArch .glslp shader preset on the GPU (SDL modes).
                       Multi-pass; overrides --video-filter, which is the
                       separate CPU post-process family.`);
  console.log(`  --video-filter <f>   CRT post-process: none, sharp, scanlines, crt (SDL modes)
  --ff-speed <n>       Fast-forward multiplier, 0=uncapped (default: 4)
  --no-rewind          Disable rewind history (saves memory + per-frame work)
  --active-bezel <ab>  Attach an Active Bezel package (.ab or unpacked directory)
  --active-bezel-auto  Discover the same-basename sidecar beside the ROM --
                       packed Game.ab or an unpacked Game.ab/ directory
  --active-bezel-config <json|@file>
                       Per-game bezel preferences
  --active-bezel-force Allow a manually selected package on a non-matching ROM
  --active-bezel-dev   Watch the package and hot reload valid changes`);
  console.log(`  --cheats <json>      Cheat codes: inline JSON or @file ([{code, enabled, desc}])`);
  console.log(`  --host-remote        Host this game for remote play; prints a share code`);
  console.log(`  --join <code>        Join a hosted game as player 2 (no ROM needed)`);
  console.log(`  --watch <code>       Watch a hosted game (spectator, no input sent)`);
  console.log(``);
  console.log(`Terminal graphics options:`);
  console.log(`  --symbols <type>     Symbol set: block, half, ascii, ascii+block, solid,`);
  console.log(`                       stipple, quad, sextant, octant, braille, matrix (default: block)`);
  console.log(`  --colors <mode>      Color mode: true, 256, 16, 2 (default: true)`);
  console.log(`  --fg-only            Foreground color only (black background)`);
  console.log(`  --dither             Enable Floyd-Steinberg dithering`);
  console.log(``);
  console.log(`Other:`);
  console.log(`  --no-gamepad         Disable gamepad input (keyboard only)`);
  console.log(`  --debug-input        Log raw SDL controller events (diagnosing dead pads)`);
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
  console.log(`  WASM       WASM Cart (.wasc)`);
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
