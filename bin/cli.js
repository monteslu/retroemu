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
  const { spawn } = await import('node:child_process');
  // A frontend spawns us with an IPC channel and drives the session over it
  // (--control). spawnSync CANNOT relay IPC — the child gets a channel the
  // parent never forwards to, so 'ready' never arrives and the frontend waits
  // forever. That made every jsgame unlaunchable from romdeck.
  //
  // So when there's a channel to preserve, spawn asynchronously and pump
  // messages both ways; this process becomes a thin relay whose only job is
  // to stay out of the way.
  const relayIpc = typeof process.send === 'function';
  const child = spawn(
    process.execPath,
    ['--experimental-vm-modules', ...process.execArgv, process.argv[1], ...process.argv.slice(2)],
    {
      stdio: relayIpc
        ? ['inherit', 'inherit', 'inherit', 'ipc']
        : 'inherit',
      env: { ...process.env, RETROEMU_REEXEChild: '1' },
    },
  );
  if (relayIpc) {
    // Either side may go away first; a dead channel must not take down a
    // session that is otherwise shutting down cleanly.
    process.on('message', (m) => { try { child.send(m); } catch { /* child gone */ } });
    child.on('message', (m) => { try { process.send(m); } catch { /* parent gone */ } });
  }
  // Signals have to reach the real process, not the relay.
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => { try { child.kill(sig); } catch { /* already gone */ } });
  }
  child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
} else {
  // No re-exec needed (or we ARE the re-exec'd child) — load and run the real
  // CLI. Only now do the native SDL/GL modules import, exactly once in this
  // process.
  await import('./cli-main.js');
}
