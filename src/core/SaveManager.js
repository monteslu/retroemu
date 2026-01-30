import fs from 'fs/promises';
import path from 'path';
import { RETRO_MEMORY_SAVE_RAM } from '../constants/libretro.js';

export class SaveManager {
  constructor(saveDir) {
    this.saveDir = saveDir;
  }

  async saveSRAM(core, romPath, silent = false) {
    const dataPtr = core._retro_get_memory_data(RETRO_MEMORY_SAVE_RAM);
    const size = core._retro_get_memory_size(RETRO_MEMORY_SAVE_RAM);
    if (!dataPtr || !size) {
      if (!silent) process.stderr.write(`SRAM save skipped: ptr=${dataPtr}, size=${size}\n`);
      return;
    }

    // Debug: write to file since terminal alternate buffer hides output
    const debugLog = (msg) => fs.appendFile('/tmp/sram-debug.log', msg + '\n').catch(() => {});
    if (!silent) {
      await debugLog(`SRAM debug at save time: ptr=${dataPtr}, size=${size}`);
      // Check entire buffer for any non-zero data
      let nonZeroRanges = [];
      let inNonZero = false;
      let rangeStart = 0;
      for (let i = 0; i < size; i++) {
        const val = core.HEAPU8[dataPtr + i];
        if (val !== 0 && !inNonZero) {
          inNonZero = true;
          rangeStart = i;
        } else if (val === 0 && inNonZero) {
          inNonZero = false;
          nonZeroRanges.push(`0x${rangeStart.toString(16)}-0x${(i-1).toString(16)}`);
        }
      }
      if (inNonZero) nonZeroRanges.push(`0x${rangeStart.toString(16)}-0x${(size-1).toString(16)}`);
      await debugLog(`Non-zero ranges in SRAM: ${nonZeroRanges.length ? nonZeroRanges.join(', ') : 'NONE - all zeros'}`);
    }

    // Copy the data (not just a view) since WASM memory may change during async write
    const data = Buffer.from(core.HEAPU8.slice(dataPtr, dataPtr + size));
    const savePath = this._sramPath(romPath);
    await fs.mkdir(path.dirname(savePath), { recursive: true });
    await fs.writeFile(savePath, data);

    // Debug: show first 32 bytes of saved data
    const preview = Array.from(data.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' ');
    if (!silent) await debugLog(`SRAM saved: ${savePath} (${size} bytes)\nSaved data: ${preview}`);
  }

  async loadSRAM(core, romPath) {
    const savePath = this._sramPath(romPath);
    const dataPtr = core._retro_get_memory_data(RETRO_MEMORY_SAVE_RAM);
    const size = core._retro_get_memory_size(RETRO_MEMORY_SAVE_RAM);

    if (!dataPtr || !size) return;

    try {
      const data = await fs.readFile(savePath);
      if (data.length === size) {
        core.HEAPU8.set(data, dataPtr);
        process.stderr.write(`SRAM loaded: ${savePath} (${size} bytes)\n`);
      } else {
        process.stderr.write(`SRAM size mismatch: file=${data.length}, expected=${size}\n`);
      }
    } catch {
      // No save file - core already initialized SRAM during retro_load_game()
      process.stderr.write(`SRAM: no existing save, using core defaults\n`);
    }
  }

  async saveState(core, romPath, slot = 0) {
    const size = core._retro_serialize_size();
    if (!size) return;

    const ptr = core._malloc(size);
    try {
      const ok = core._retro_serialize(ptr, size);
      if (ok) {
        const data = Buffer.from(core.HEAPU8.buffer, ptr, size);
        const statePath = this._statePath(romPath, slot);
        await fs.mkdir(path.dirname(statePath), { recursive: true });
        await fs.writeFile(statePath, data);
      }
    } finally {
      core._free(ptr);
    }
  }

  async loadState(core, romPath, slot = 0) {
    const statePath = this._statePath(romPath, slot);
    try {
      const data = await fs.readFile(statePath);
      const ptr = core._malloc(data.length);
      try {
        core.HEAPU8.set(data, ptr);
        core._retro_unserialize(ptr, data.length);
      } finally {
        core._free(ptr);
      }
    } catch {
      // No state file exists
    }
  }

  _sramPath(romPath) {
    const name = path.basename(romPath, path.extname(romPath));
    return path.join(this.saveDir, `${name}.srm`);
  }

  _statePath(romPath, slot) {
    const name = path.basename(romPath, path.extname(romPath));
    return path.join(this.saveDir, `${name}.state${slot}`);
  }
}
