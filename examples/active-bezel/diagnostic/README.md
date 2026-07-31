# Diagnostic Active Bezel

This is the smallest C source package for ABI v1. `abtool scaffold <dir> c`
copies both the C header and machine-readable ABI into the new project.
Compile `main.c` to a freestanding WASM module and place it at `main.wasm`.
For a Clang-compatible WebAssembly SDK, the complete command is:

```sh
clang --target=wasm32 -O2 -nostdlib \
  -Wl,--no-entry -Wl,--allow-undefined \
  -Wl,--export=ab_abi_version -Wl,--export=ab_init -Wl,--export=ab_tick \
  main.c -o main.wasm
```

Then run:

```sh
abtool pack . diagnostic.ab
retroemu game.nes --video sdl --active-bezel diagnostic.ab --active-bezel-force
```

The diagnostic is intentionally not tied to a commercial ROM. Forced mode is
the expected way to attach it while developing.
