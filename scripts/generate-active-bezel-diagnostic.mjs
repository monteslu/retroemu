// Produces the checked-in diagnostic main.wasm without requiring a host
// compiler. This tiny module is the package/lifecycle/compositor smoke guest;
// examples/active-bezel/diagnostic/main.c is the readable SDK equivalent.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const u32 = (n) => {
  const out = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return out;
};
const str = (s) => [...u32(Buffer.byteLength(s)), ...Buffer.from(s)];
const section = (id, body) => [id, ...u32(body.length), ...body];
const f64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(n);
  return [...b];
};

// Types: lifecycle plus the two command-list imports used by this smoke guest.
const types = [
  5,
  0x60, 0, 1, 0x7f,
  0x60, 1, 0x7f, 1, 0x7f,
  0x60, 1, 0x7e, 0,
  0x60, 1, 0x7f, 0,
  0x60, 5, 0x7c, 0x7c, 0x7c, 0x7c, 0x7f, 0,
];
const imports = [
  2,
  ...str('ab_host'), ...str('command_clear'), 0, 3,
  ...str('ab_host'), ...str('command_draw_game'), 0, 4,
];
const functions = [3, 0, 1, 2];
const exports = [
  3,
  ...str('ab_abi_version'), 0, 2,
  ...str('ab_init'), 0, 3,
  ...str('ab_tick'), 0, 4,
];
const tick = [
  0,
  0x41, ...u32(0x101520ff), 0x10, 0,
  0x44, ...f64(320), 0x44, ...f64(0),
  0x44, ...f64(1280), 0x44, ...f64(1080),
  0x41, 0, 0x10, 1,
  0x0b,
];
const code = [
  3,
  4, 0, 0x41, 1, 0x0b,
  4, 0, 0x41, 0, 0x0b,
  ...u32(tick.length), ...tick,
];
const wasm = Buffer.from([
  0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
  ...section(1, types), ...section(2, imports), ...section(3, functions),
  ...section(7, exports), ...section(10, code),
]);
const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(here, '../examples/active-bezel/diagnostic/main.wasm');
await fs.writeFile(output, wasm);
console.log(output);
