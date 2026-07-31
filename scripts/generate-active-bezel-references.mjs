// Builds the remaining hand-encoded reference guests. Adventure is deliberately
// excluded: its checked-in main.wasm is compiled from main.c by
// build-active-bezel-adventure.sh.
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
const i32 = (n) => {
  const out = [];
  let more = true;
  while (more) {
    let byte = n & 0x7f;
    n >>= 7;
    const sign = byte & 0x40;
    more = !((n === 0 && !sign) || (n === -1 && sign));
    if (more) byte |= 0x80;
    out.push(byte);
  }
  return out;
};
const str = (s) => [...u32(Buffer.byteLength(s)), ...Buffer.from(s)];
const section = (id, bytes) => [id, ...u32(bytes.length), ...bytes];
const f64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(n);
  return [...b];
};
const f = (n) => [0x44, ...f64(n)];
const iconst = (n) => [0x41, ...i32(n)];
const call = (n) => [0x10, ...u32(n)];

function fillRect(x, y, w, h, color) {
  return [...f(x), ...f(y), ...f(w), ...f(h), ...iconst(color | 0), ...call(2)];
}
function drawGame(x, y, w, h) {
  return [...f(x), ...f(y), ...f(w), ...f(h), ...iconst(0), ...call(1)];
}
function dynamicBar(x, y, scale, h, offset, color) {
  return [
    ...f(x), ...f(y),
    0x20, 1, ...iconst(offset), ...call(4), 0xb8, ...f(scale), 0xa2,
    ...f(h), ...iconst(color | 0), ...call(2),
  ];
}
function moduleFor({ clear, commands }) {
  const types = [
    7,
    0x60, 1, 0x7f, 0,
    0x60, 5, 0x7c, 0x7c, 0x7c, 0x7c, 0x7f, 0,
    0x60, 1, 0x7f, 1, 0x7f,
    0x60, 2, 0x7f, 0x7f, 1, 0x7f,
    0x60, 0, 1, 0x7f,
    0x60, 1, 0x7f, 1, 0x7f,
    0x60, 1, 0x7e, 0,
  ];
  const imports = [
    5,
    ...str('ab_host'), ...str('command_clear'), 0, 0,
    ...str('ab_host'), ...str('command_draw_game'), 0, 1,
    ...str('ab_host'), ...str('command_fill_rect'), 0, 1,
    ...str('ab_host'), ...str('region_find_id'), 0, 2,
    ...str('ab_host'), ...str('region_read_u8'), 0, 3,
  ];
  const functions = [3, 4, 5, 6];
  const exports = [
    3,
    ...str('ab_abi_version'), 0, 5,
    ...str('ab_init'), 0, 6,
    ...str('ab_tick'), 0, 7,
  ];
  const tick = [
    1, 1, 0x7f,
    ...iconst(2), ...call(3), 0x21, 1,
    ...iconst(clear | 0), ...call(0),
    ...commands,
    0x0b,
  ];
  const code = [
    3,
    4, 0, ...iconst(1), 0x0b,
    4, 0, ...iconst(0), 0x0b,
    ...u32(tick.length), ...tick,
  ];
  return Buffer.from([
    0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...section(1, types), ...section(2, imports), ...section(3, functions),
    ...section(7, exports), ...section(10, code),
  ]);
}

const packages = {
  'metroid2-map': moduleFor({
    clear: 0x08120fff,
    commands: [
      ...drawGame(360, 0, 1200, 1080),
      ...fillRect(40, 80, 260, 920, 0x182838ff),
      ...fillRect(1620, 80, 260, 920, 0x182838ff),
      ...dynamicBar(70, 220, 2.5, 52, 0x1051, 0xa8d878ff),
      ...dynamicBar(1650, 220, 2, 52, 0x1054, 0xe05858ff),
      ...dynamicBar(1650, 330, 8, 28, 0x1050, 0x78a8e8ff),
    ],
  }),
  'smb-expanded': moduleFor({
    clear: 0x5c94fcff,
    commands: [
      ...drawGame(0, 0, 1440, 1080),
      ...fillRect(1440, 0, 480, 1080, 0x182030ff),
      ...fillRect(1490, 100, 380, 600, 0x304050ff),
      ...dynamicBar(1510, 840, 24, 40, 0x075a, 0xf8d858ff),
      ...dynamicBar(1510, 920, 80, 30, 0x075c, 0x80d8f8ff),
    ],
  }),
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples/active-bezel');
for (const [name, wasm] of Object.entries(packages)) {
  await fs.writeFile(path.join(root, name, 'main.wasm'), wasm);
  await WebAssembly.compile(wasm);
  console.log(`${name}: ${wasm.length} bytes`);
}
