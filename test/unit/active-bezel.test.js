import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ActiveBezelPackage, validateManifest } from 'active-bezel/package';
import { matchActiveBezel } from 'active-bezel/matcher';
import { ActiveBezelRuntime, AB_EVENT } from 'active-bezel/runtime';
import { ActiveBezelConfig } from 'active-bezel/config';
import { ActiveBezelCompositor } from 'active-bezel/compositor';
import { ActiveBezelGpuCompositor } from 'active-bezel/gpu-compositor';
import { CORE_REGIONS } from 'active-bezel/regions';
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
const str = (s) => {
  const b = [...Buffer.from(s)];
  return [...u32(b.length), ...b];
};
const section = (id, bytes) => [id, ...u32(bytes.length), ...bytes];

function storedZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  const word = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const dword = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  for (const [entryName, value] of entries) {
    const name = Buffer.from(entryName);
    const data = Buffer.from(value);
    const local = Buffer.concat([
      dword(0x04034b50), word(20), word(0), word(0), word(0), word(0),
      dword(0), dword(data.length), dword(data.length), word(name.length), word(0), name, data,
    ]);
    locals.push(local);
    central.push(Buffer.concat([
      dword(0x02014b50), word(20), word(20), word(0), word(0), word(0), word(0),
      dword(0), dword(data.length), dword(data.length), word(name.length), word(0), word(0),
      word(0), word(0), dword(0), dword(offset), name,
    ]));
    offset += local.length;
  }
  const directory = Buffer.concat(central);
  return Buffer.concat([
    ...locals, directory, dword(0x06054b50), word(0), word(0),
    word(entries.length), word(entries.length), dword(directory.length), dword(offset), word(0),
  ]);
}

function minimalGuest() {
  const types = [
    3,
    0x60, 0, 1, 0x7f,
    0x60, 1, 0x7f, 1, 0x7f,
    0x60, 1, 0x7e, 0,
  ];
  const functions = [3, 0, 1, 2];
  const exports = [
    3,
    ...str('ab_abi_version'), 0, 0,
    ...str('ab_init'), 0, 1,
    ...str('ab_tick'), 0, 2,
  ];
  const bodies = [
    3,
    4, 0, 0x41, 1, 0x0b,
    4, 0, 0x41, 0, 0x0b,
    2, 0, 0x0b,
  ];
  return Buffer.from([
    0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...section(1, types),
    ...section(3, functions),
    ...section(7, exports),
    ...section(10, bodies),
  ]);
}

function directMemoryReaderGuest() {
  const types = [1, 0x60, 1, 0x7f, 1, 0x7f];
  const imports = [1, ...str('ab_core'), ...str('memory'), 2, 0, 1];
  const functions = [1, 0];
  const exports = [1, ...str('read_u8'), 0, 0];
  const bodies = [1, 7, 0, 0x20, 0, 0x2d, 0, 0, 0x0b];
  return Buffer.from([
    0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...section(1, types), ...section(2, imports), ...section(3, functions),
    ...section(7, exports), ...section(10, bodies),
  ]);
}

function manifestFor(rom, extra = {}) {
  return {
    format: 'active-bezel',
    formatVersion: 1,
    id: 'org.test.diagnostic',
    name: 'Diagnostic',
    version: '1.0.0',
    entry: 'main.wasm',
    runtime: { abi: 'active-bezel-1', renderer: 'cpu-rgba-v1', extensions: [] },
    games: [{ platform: 'nes', sha256: crypto.createHash('sha256').update(rom).digest('hex') }],
    settings: [{ key: 'map', type: 'boolean', default: true }],
    ...extra,
  };
}

test('manifest validation rejects malformed settings and accepts v1', () => {
  const rom = Buffer.from([1, 2, 3]);
  assert.equal(validateManifest(manifestFor(rom)).runtime.abi, 'active-bezel-1');
  assert.throws(
    () => validateManifest(manifestFor(rom, { settings: [{ key: '../bad', type: 'boolean' }] })),
    /invalid key/,
  );
});

test('package loader rejects malformed archives, traversal, missing entries and unsupported ABI', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'active-bezel-invalid-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const malformed = path.join(dir, 'malformed.ab');
  await fs.writeFile(malformed, 'not a zip');
  await assert.rejects(() => ActiveBezelPackage.open(malformed));

  const traversal = path.join(dir, 'traversal.ab');
  await fs.writeFile(traversal, storedZip([['../escape', 'bad']]));
  await assert.rejects(() => ActiveBezelPackage.open(traversal), /unsafe package entry|invalid relative path/);

  const missing = path.join(dir, 'missing');
  await fs.mkdir(missing);
  const manifest = manifestFor(Buffer.from([1]));
  await fs.writeFile(path.join(missing, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(() => ActiveBezelPackage.open(missing), /missing main.wasm/);

  assert.throws(
    () => validateManifest({ ...manifest, runtime: { ...manifest.runtime, abi: 'active-bezel-99' } }),
    /active-bezel-1/,
  );
});

test('configuration normalizes every v1 type, actions, migration and defaults', () => {
  const schema = [
    { key: 'enabled', type: 'boolean', default: true },
    { key: 'count', type: 'integer', default: 2, min: 0, max: 5 },
    { key: 'opacity', type: 'float', default: 0.5, min: 0, max: 1 },
    { key: 'scale', type: 'number', default: 1 },
    { key: 'side', type: 'choice', choices: ['left', 'right'], default: 'right' },
    { key: 'tint', type: 'color', default: '#102030' },
    { key: 'reveal', type: 'action' },
  ];
  const config = new ActiveBezelConfig(schema, {
    enabled: 0, count: 99, opacity: '0.75', side: 'removed-old-value', tint: 'bad',
  });
  assert.deepEqual(config.values, {
    enabled: false, count: 5, opacity: 0.75, scale: 1,
    side: 'right', tint: '#102030', reveal: 0,
  });
  assert.equal(config.set('reveal'), 1);
  assert.equal(config.set('reveal'), 2);
  assert.equal(config.set('count', -99), 0);
  assert.throws(() => config.set('unknown', true), /unknown Active Bezel setting/);
});

test('matching distinguishes exact, compatible, forced and none', () => {
  const rom = Buffer.from([1, 2, 3, 4]);
  const manifest = manifestFor(rom);
  assert.equal(matchActiveBezel(manifest, rom, 'nes').level, 'exact');
  const other = Buffer.from([1, 2, 9, 4]);
  manifest.games = [];
  manifest.compatible = [{ platform: 'nes', size: 4, signatures: [{ offset: 0, bytes: '0102' }] }];
  assert.equal(matchActiveBezel(manifest, other, 'nes').level, 'compatible');
  assert.equal(matchActiveBezel({ ...manifest, compatible: [] }, other, 'nes').level, 'none');
  assert.equal(matchActiveBezel({ ...manifest, compatible: [] }, other, 'nes', { force: true }).level, 'forced');
});

test('two WASM modules can share the exact core memory object without copying', async () => {
  const coreMemory = new WebAssembly.Memory({ initial: 1 });
  const coreView = new Uint8Array(coreMemory.buffer);
  coreView[0x234] = 0xa7;
  const { instance } = await WebAssembly.instantiate(directMemoryReaderGuest(), {
    ab_core: { memory: coreMemory },
  });
  assert.equal(instance.exports.read_u8(0x234), 0xa7);
  coreView[0x234] = 0x5c;
  assert.equal(instance.exports.read_u8(0x234), 0x5c);
});

test('directory package loads and runtime composes a complete 16:9 frame', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'active-bezel-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const rom = Buffer.from([1, 2, 3, 4]);
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifestFor(rom)));
  await fs.writeFile(path.join(dir, 'main.wasm'), minimalGuest());
  const pkg = await ActiveBezelPackage.open(dir);
  assert.equal(pkg.manifest.name, 'Diagnostic');

  const heap = new Uint8Array(65536);
  const host = {
    core: {
      HEAPU8: heap,
      _retro_get_memory_data: (id) => id === 2 ? 1024 : 0,
      _retro_get_memory_size: (id) => id === 2 ? 2048 : 0,
    },
  };
  const runtime = await ActiveBezelRuntime.create({
    packagePath: dir, host, romBytes: rom, platform: 'nes',
    outputWidth: 320, outputHeight: 180,
  });
  assert.equal(runtime.status().match.level, 'exact');
  assert.equal(runtime.setConfig('map', false), false);
  runtime.event(AB_EVENT.RESET);
  const game = new Uint8Array(4 * 4 * 4).fill(255);
  const frame = runtime.processFrame(game, 4, 4, 1);
  assert.deepEqual([frame.width, frame.height, frame.rgba.length], [320, 180, 320 * 180 * 4]);
  assert.equal(runtime.status().stats.ticks, 1);
});

test('command compositor draws alpha rectangles, triangles, text and clipping', () => {
  const compositor = new ActiveBezelCompositor({ outputWidth: 160, outputHeight: 90 });
  compositor.clear(0x000000ff);
  compositor.fillRect(0, 0, 960, 1080, 0xff0000ff);
  compositor.scissor(960, 0, 960, 540);
  compositor.fillRect(960, 0, 960, 1080, 0x00ff00ff);
  compositor.resetScissor();
  compositor.triangle(960, 540, 1920, 540, 1920, 1080, 0x0000ffff);
  compositor.text('AB1', 1000, 100, 50, 0xffffffff);
  const frame = compositor.compose(new Uint8Array(4), 1, 1);
  const at = (x, y) => [...frame.rgba.subarray((y * 160 + x) * 4, (y * 160 + x) * 4 + 4)];
  assert.deepEqual(at(10, 80), [255, 0, 0, 255]);
  assert.deepEqual(at(100, 10), [0, 255, 0, 255]);
  assert.deepEqual(at(100, 80), [0, 0, 0, 255]);
  assert.deepEqual(at(150, 80), [0, 0, 255, 255]);
  assert.ok(frame.rgba.some((value, i) => value === 255 && i % 4 < 3));
});

test('command compositor rejects an unbounded guest command stream', () => {
  const compositor = new ActiveBezelCompositor({
    outputWidth: 16, outputHeight: 9, maxCommands: 2,
  });
  compositor.fillRect(0, 0, 1, 1, 0xffffffff);
  compositor.fillRect(1, 0, 1, 1, 0xffffffff);
  assert.throws(
    () => compositor.fillRect(2, 0, 1, 1, 0xffffffff),
    /command limit exceeded/,
  );
});

test('OpenGL command compositor matches CPU reference and releases resources', (t) => {
  const gpu = ActiveBezelGpuCompositor.create({ outputWidth: 160, outputHeight: 90 });
  if (!gpu) return t.skip('OpenGL ES context unavailable');
  const cpu = new ActiveBezelCompositor({ outputWidth: 160, outputHeight: 90 });
  const game = new Uint8Array(16 * 9 * 4);
  for (let i = 0; i < game.length; i += 4) {
    game[i] = (i / 4) & 255;
    game[i + 1] = 100;
    game[i + 2] = 200;
    game[i + 3] = 255;
  }
  for (const compositor of [cpu, gpu]) {
    compositor.clear(0x101020ff);
    compositor.drawGame(240, 0, 1440, 1080);
    compositor.fillRect(0, 0, 240, 1080, 0xff000080);
    compositor.triangle(1600, 0, 1920, 540, 1600, 1080, 0x00ff00ff);
    compositor.scissor(1400, 0, 200, 200);
    compositor.fillRect(1300, 0, 400, 400, 0xffff00ff);
    compositor.resetScissor();
    const texture = compositor.createTexture(new Uint8Array([
      255, 255, 255, 255, 0, 0, 0, 255,
      0, 0, 0, 255, 255, 255, 255, 255,
    ]), 2, 2);
    compositor.drawTexture(texture, 1700, 800, 120, 120);
  }
  const expected = cpu.compose(game, 16, 9).rgba;
  const actual = gpu.compose(game, 16, 9).rgba;
  let error = 0;
  let samples = 0;
  for (let i = 0; i < expected.length; i++) {
    if (i % 4 === 3) continue;
    error += Math.abs(expected[i] - actual[i]);
    samples++;
  }
  // Sub-byte mean tolerance permits rasterizer edge ownership differences.
  assert.ok(error / samples < 0.3, `mean channel error ${error / samples}`);
  gpu.destroy();
  assert.equal(gpu.gpuReady, false);
});

test('canonical region catalog uses stable unique NAMES (some ids are shared by design)', () => {
  // Ids 0x110-0x113 are deliberately shared between the NES redraw planes and
  // the SNES oam/cgram/aram/fillram entries: both sets are baked into the
  // COMPILED cores, only one core is ever loaded at a time, and renumbering
  // the JS alone makes the host ask a core for ids it does not implement
  // (verified upstream: SNES reads went empty). Names are the unique handle.
  const SHARED_IDS = new Set([0x110, 0x111, 0x112, 0x113]);
  const names = new Set(CORE_REGIONS.map((region) => region.name));
  assert.equal(names.size, CORE_REGIONS.length, 'region names must be unique');
  const seen = new Map();
  for (const region of CORE_REGIONS) {
    if (seen.has(region.id)) {
      assert.ok(SHARED_IDS.has(region.id),
        `id 0x${region.id.toString(16)} shared by ${seen.get(region.id)} and ${region.name} without being on the documented shared list`);
    }
    seen.set(region.id, region.name);
  }
  assert.ok(names.has('nes_palette'));
  assert.ok(names.has('gb_vram'));
  assert.ok(names.has('gba_oam'));
});

test('machine-readable ABI schema covers the runtime contract', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const abi = JSON.parse(await fs.readFile(
    path.resolve(here, '../../sdk/active-bezel/abi.json'), 'utf8',
  ));
  assert.equal(abi.version, 2);
  for (const name of ['ab_abi_version', 'ab_init', 'ab_tick']) {
    assert.equal(abi.guestExports[name].required, true);
  }
  /* ABI 2 additions stay OPTIONAL: a version-1 guest must keep loading. */
  for (const name of ['ab_pre_render', 'ab_pre_render_defined']) {
    assert.equal(abi.guestExports[name].required, false, `${name} must be optional`);
  }
  for (const name of [
    'input_state', 'input_override', 'region_generation', 'region_read_u8',
    'region_write_u8', 'command_draw_game', 'command_draw_texture',
  ]) assert.ok(abi.hostImports[name], `ABI import ${name}`);
});

test('checked-in C and Lua reference packages validate and compile', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const examples = path.resolve(here, '../../examples/active-bezel');
  for (const name of ['diagnostic', 'adventure-map', 'metroid2-map', 'smb-expanded', 'lua-starter']) {
    const pkg = await ActiveBezelPackage.open(path.join(examples, name));
    assert.ok(await WebAssembly.compile(pkg.read(pkg.manifest.entry)));
  }
});

test('runtime remains stable for 10,000 lifecycle ticks', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'active-bezel-soak-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const rom = Buffer.from([5, 6, 7, 8]);
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifestFor(rom, {
    runtime: {
      abi: 'active-bezel-1', renderer: 'cpu-rgba-v1',
      internalResolution: [16, 9], extensions: [],
    },
  })));
  await fs.writeFile(path.join(dir, 'main.wasm'), minimalGuest());
  const heap = new Uint8Array(65536);
  const host = {
    core: {
      HEAPU8: heap,
      _retro_get_memory_data: (id) => id === 2 ? 1024 : 0,
      _retro_get_memory_size: (id) => id === 2 ? 2048 : 0,
    },
  };
  const runtime = await ActiveBezelRuntime.create({
    packagePath: dir, host, romBytes: rom, platform: 'nes',
    outputWidth: 16, outputHeight: 9,
  });
  const game = new Uint8Array(4);
  const outputIdentity = runtime.compositor.output;
  for (let i = 0; i < 10_000; i++) runtime.processFrame(game, 1, 1, i);
  assert.equal(runtime.status().stats.ticks, 10_000);
  assert.equal(runtime.compositor.output, outputIdentity);
  runtime.event(AB_EVENT.STATE_LOADED);
  runtime.event(AB_EVENT.REWIND_JUMP);
  runtime.shutdown();
  assert.equal(runtime.enabled, false);
});
