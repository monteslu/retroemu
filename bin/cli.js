#!/usr/bin/env -S node --experimental-wasm-exnref

// Thin bootstrap. Its ONLY job: decide whether to re-exec with --experimental-vm-modules
// (which jsgame/rungame's vm.SourceTextModule realm needs) BEFORE any heavy native module
// loads. It imports nothing native itself — the real CLI lives in ./cli-main.js and is
// dynamic-imported below, AFTER the re-exec decision.
//
// Why this matters (the macOS crash): the SDL/GL native modules (native-gles, @kmamal/sdl
// via rungame/wasmcart) initialize at import time. If we re-exec AFTER they've imported,
// SDL initializes twice (parent + child) and crashes silently on macOS. So we re-exec here,
// before importing anything native, and only for jsgame (the sole system that needs the flag).

const romArg = process.argv.slice(2).find((a) => !a.startsWith('-')) || '';
const isJsGameRom = /\.jsg(ame)?$/i.test(romArg);
const needsFlag = isJsGameRom
  && !process.execArgv.some((a) => a.includes('experimental-vm-modules'))
  && !process.env.RETROEMU_REEXEChild;

if (needsFlag) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(
    process.execPath,
    ['--experimental-vm-modules', ...process.execArgv, process.argv[1], ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, RETROEMU_REEXEChild: '1' } },
  );
  process.exit(r.status ?? 0);
}

// No re-exec needed (or we ARE the re-exec'd child) — load and run the real CLI. Only now do
// the native SDL/GL modules import, exactly once in this process.
await import('./cli-main.js');
