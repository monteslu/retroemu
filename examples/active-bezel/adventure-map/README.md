# Adventure Living Map

AB-R1 turns the otherwise empty widescreen area into a live room map driven by
the game's 128-byte RAM. It ships no ROM or extracted in-game graphics. It does
currently include a copy of the original packaging art for the right panel.
The exact supported ROM hash is in `manifest.json`; `profile.json` documents
every address the package relies on.

This is currently a runtime demonstration, not a finished strategy map. Room,
X, and Y reads are live, but the five-by-six room layout and `0.35` marker
scale are placeholders pending a romdev-correlated gameplay trace. The
`show_objects` setting is also reserved but not consumed yet. The game
rectangle currently stretches the raw core picture; TV/display-aspect-aware
placement is an outstanding host/runtime task.

`main.wasm` is genuinely compiled from `main.c` with Emscripten; it is not a
hand-encoded placeholder. From the repository root, rebuild it with:

```sh
npm run build:active-bezel-adventure
```

If `emcc` is not on `PATH`, point the script at an existing Emscripten compiler:

```sh
EMCC=/path/to/emsdk/upstream/emscripten/emcc \
  npm run build:active-bezel-adventure
```

The build is freestanding (`-nostdlib`) and imports only the small Active Bezel
host ABI declared in `sdk/active-bezel/active_bezel.h`.

The right panel uses the original Adventure packaging image from the
[Atari 2600 cartridge tour](https://2600adventures.atari.org/cartridge-tour.php).
It is stored as a raw 150×209 RGBA texture so the guest can upload it directly
through the ABI without carrying an image decoder. That makes this a local
development demonstration; do not assume the packaging art is cleared for
redistribution.
