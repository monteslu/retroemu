import { fileURLToPath } from 'url';
import path from 'path';
import { existsSync, readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CORES_DIR = path.resolve(__dirname, '..', '..', 'cores');

// Cores consumed from romdev's standalone, hardened npm packages instead of the bundled
// cores/ dir. romdev maintains the canonical builds for these (glide64-GL N64, NODERAWFS
// PS1, the GameTank core) — newer + better than what retroemu shipped, and this is the
// convergence direction: stop building the same cores twice. Each package exports
// `{ core: { jsPath, wasmPath } }`. Everything else still loads from CORES_DIR.
const CORE_PACKAGES = {
  parallel_n64: 'romdev-core-parallel-n64',
  beetle_psx_hw: 'romdev-core-beetle-psx-hw',
  gametank: 'romdev-core-gametank',
};

/** Resolve a core's glue-.js + .wasm paths — from a romdev package if mapped, else cores/. */
async function resolveCorePaths(coreName) {
  const pkg = CORE_PACKAGES[coreName];
  if (pkg) {
    const { core } = await import(pkg);
    return { gluePath: core.jsPath, wasmPath: core.wasmPath, source: pkg };
  }
  return {
    gluePath: path.join(CORES_DIR, `${coreName}_libretro.js`),
    wasmPath: path.join(CORES_DIR, `${coreName}_libretro.wasm`),
    source: 'bundled',
  };
}

export async function loadCore(coreName, { glBridge, glCanvas } = {}) {
  const { gluePath, wasmPath: coreWasmPath, source } = await resolveCorePaths(coreName);

  if (!existsSync(gluePath)) {
    throw new Error(
      `Core "${coreName}" not found at ${gluePath} (source: ${source}).\n` +
      (source === 'bundled'
        ? `Run: npm run build:core -- ${coreName}\nOr:  npm run build:cores`
        : `The ${source} package is missing its wasm — reinstall deps (npm install).`)
    );
  }

  // Dynamic import of Emscripten ES6 module factory
  const glueModule = await import(gluePath);
  const createModule = glueModule.default;

  // Build module options
  const moduleOpts = {};

  if (glCanvas) {
    // For cores built with -O3 -flto (minified imports), the Emscripten glue
    // handles GL internally via GLctx = canvas.getContext("webgl2").
    // We provide a fake canvas whose getContext returns our native-gles adapter.
    moduleOpts.canvas = glCanvas;

    // Emscripten's web GL code checks for WebGLRenderingContext globally
    if (typeof globalThis.WebGLRenderingContext === 'undefined') {
      const { WebGL2RenderingContext } = await import('webgl-node');
      globalThis.WebGLRenderingContext = WebGL2RenderingContext;
      globalThis.WebGL2RenderingContext = WebGL2RenderingContext;
    }
  }

  if (glBridge) {
    // For cores with unminified imports (e.g. mupen64plus-nx built without LTO),
    // patch GL functions directly in the WASM env imports. Use the resolved wasm path
    // (a romdev package's wasm when mapped, else the bundled cores/ one).
    const wasmBinary = readFileSync(coreWasmPath);

    moduleOpts.instantiateWasm = (info, receiveInstance) => {
      // Search all import namespaces for GL function names to patch.
      for (const ns of Object.values(info)) {
        if (typeof ns !== 'object' || ns === null) continue;
        for (const [name, fn] of Object.entries(glBridge)) {
          if (name in ns) {
            ns[name] = fn;
          }
        }
        // Also patch EGL functions to no-op (we manage EGL ourselves)
        if ('eglGetDisplay' in ns) {
          ns.eglGetDisplay = () => 62000;
          ns.eglInitialize = (display, major, minor) => 1;
          ns.eglQueryString = () => 0;
        }
      }

      WebAssembly.instantiate(wasmBinary, info).then(result => {
        if (glBridge._setMemory && result.instance.exports.memory) {
          glBridge._setMemory(result.instance.exports.memory);
        }
        receiveInstance(result.instance, result.module);
      });
      return {};
    };
  }

  // Instantiate the WASM module
  const wasmModule = await createModule(moduleOpts);

  // Verify it exposes the libretro API
  if (typeof wasmModule._retro_api_version !== 'function') {
    throw new Error(`Core "${coreName}" does not export retro_api_version`);
  }

  const apiVersion = wasmModule._retro_api_version();
  if (apiVersion !== 1) {
    throw new Error(`Core "${coreName}" has unsupported API version: ${apiVersion}`);
  }

  return wasmModule;
}

export function getCoresDir() {
  return CORES_DIR;
}
