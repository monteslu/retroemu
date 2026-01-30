import { fileURLToPath } from 'url';
import path from 'path';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CORES_DIR = path.resolve(__dirname, '..', '..', 'cores');

export async function loadCore(coreName) {
  const gluePath = path.join(CORES_DIR, `${coreName}_libretro.js`);

  if (!existsSync(gluePath)) {
    throw new Error(
      `Core "${coreName}" not found at ${gluePath}.\n` +
      `Run: npm run build:core -- ${coreName}\n` +
      `Or:  npm run build:cores`
    );
  }

  // Dynamic import of Emscripten ES6 module factory
  const glueModule = await import(gluePath);
  const createModule = glueModule.default;

  // Instantiate the WASM module
  const wasmModule = await createModule();

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
