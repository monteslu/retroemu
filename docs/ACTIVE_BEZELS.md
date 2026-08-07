# Active Bezels v1

Active Bezels are optional, ROM-specific WebAssembly companions that own
retroemu's complete 16:9 picture. A package can place or transform the original
game, render maps and telemetry around it, read live machine regions, and—when
the author chooses—write those regions like a trainer or Game Genie. The core
runs first, the bezel runs second against the same current machine state, and
retroemu presents the completed frame.

## Running and developing

```sh
retroemu game.nes --video sdl --active-bezel enhancement.ab
retroemu game.nes --video sdl --active-bezel ./unpacked-bezel --active-bezel-dev
retroemu game.nes --active-bezel enhancement.ab --active-bezel-force
retroemu game.nes --active-bezel enhancement.ab \
  --active-bezel-config '{"show_map":true}'
```

Developer mode watches an unpacked directory or archive and replaces the guest
at a frame boundary. A failed reload leaves the previous working guest active.

```sh
abtool scaffold my-bezel c
abtool scaffold my-lua-bezel lua
abtool verify my-bezel
abtool pack my-bezel my-bezel.ab
abtool inspect my-bezel.ab
```

`abtool pack` emits a deterministic stored ZIP. `.ab` is deliberately ordinary:
rename it to `.zip` to inspect it.

The C scaffold includes `active_bezel.h`, `abi.json`, readable source, and a
known-good `main.wasm`. Its README gives the freestanding wasm32 compile
command. The Lua scaffold needs no compiler: edit `app/main.lua` and reload.

## Package shape

```text
manifest.json
main.wasm
assets/...
```

The required manifest fields are:

```json
{
  "format": "active-bezel",
  "formatVersion": 1,
  "id": "org.example.my-bezel",
  "name": "My Bezel",
  "version": "1.0.0",
  "entry": "main.wasm",
  "runtime": {
    "abi": "active-bezel-1",
    "renderer": "gpu-command-v1",
    "internalResolution": [640, 360],
    "extensions": []
  },
  "games": [{
    "platform": "nes",
    "sha256": "64 lowercase hex characters"
  }],
  "requires": [{ "region": "system_ram", "minSize": 2048 }],
  "settings": []
}
```

Exact SHA-256 matches are authoritative. `compatible` rules may additionally
identify known revisions by platform, total size, and multiple byte signatures.
They are weaker and reported as such. Mismatches never auto-attach; the player
may explicitly force one.

Packages are capped at 128 MiB unpacked, each entry at 64 MiB. Absolute paths,
traversal, backslashes, NUL names, and symlinks are rejected.

## Frame and display contract

The ABI canvas is always 1920×1080 logical units. This is geometry, not a demand
to shade two million CPU pixels. `runtime.internalResolution` selects a reusable
16:9 CPU surface; SDL then performs hardware presentation scaling to the actual
1080p or 4K display. There are no per-frame output allocations.

Each emulation tick is:

1. Apply current input.
2. Run the libretro core.
3. Expose the resulting live memory and core framebuffer.
4. Call `ab_tick(frame)`.
5. Execute the guest's complete composition.
6. Apply the selected picture effect at its declared scope.
7. Publish the same final composite to SDL, screenshots, recording, and remote
   consumers.

The bezel decides where the game goes. If it submits no commands at all,
retroemu supplies a centered aspect-correct fallback. A guest framebuffer is
treated as a complete picture, not decoration behind a host-owned layout.

## ABI

The machine-readable source of truth is `sdk/active-bezel/abi.json`; the C binding is
`sdk/active-bezel/active_bezel.h`.

Required exports:

```c
int32_t ab_abi_version(void);
int32_t ab_init(uint32_t descriptor);
void ab_tick(uint64_t frame);
```

Optional exports are `ab_event`, `ab_shutdown`, the CPU framebuffer trio, and
(ABI 2, active-bezel 0.8.0+) `ab_pre_frame` — called BEFORE every core frame,
where a guest may write live regions and stage `input_override` for what the
core is polled with that frame. Overrides clear every frame; input reads keep
reporting the physical pad so a remap cannot feed back on itself. retroemu
runs the hook on its per-frame choke point (`host.beforeFrame`), so no frame
driver skips it. A guest that uses ABI 2 imports fail loudly (LinkError) on
pre-0.8.0 hosts by design; ABI 1 guests run unchanged.
Lifecycle events cover reset, state load, rewind jump, live configuration,
display change, asset reload, and region relocation.

The host imports include:

- Display geometry, ABI version and current controller state.
- Region enumeration, stable IDs, byte reads/writes, size, flags, and live
  offsets, plus a generation counter after reset/state/rewind relocation.
- Typed boolean/number/string configuration.
- Package asset size/read calls.
- Clear, game placement/fitting, alpha rectangle, triangle, text, scissor, and
  reset.
- Persistent RGBA texture create/draw/destroy handles.

Colors are packed `0xRRGGBBAA`. Geometry uses logical canvas coordinates.
Nearest sampling is the pixel-art default.

## Memory

`system_ram`, `save_ram`, `video_ram`, and `rtc` retain their libretro IDs.
Patched core regions use the exact stable IDs already used by Romdev: NES
nametables/palette/OAM/CHR, GB VRAM/OAM/IO/HRAM, Genesis CRAM/VSRAM/VDP state,
GBA palette/OAM/IWRAM, and the equivalent regions for every supported classic
core. `cart_source` is an immutable copy of the loaded ROM.

When a core exposes its `WebAssembly.Memory`, a guest may import the identical
object as `ab_core.memory`; no serialized game-state object or full-RAM copy is
created. Named accessors remain available for portability and for core regions
that are not slices of that memory. Writes are intentional and immediate. An
author who enables them owns the consequences.

## Picture effects

`pictureEffect` is `none`, `game`, `scene`, or `composite`.

- `game`: CPU filters run on the original core picture before composition.
- `scene`/`composite`: the effect runs over the completed 16:9 output.
- `none`: the bezel requests an unfiltered result.

Existing `.glslp` presets can render either the original game to an offscreen
GPU target before composition (`game`) or the completed Active Bezel scene
after composition (`scene`/`composite`). `none` suppresses the configured
picture effect. CPU filters follow the same ordering. The offscreen shader
result is read back into the authoritative RGBA composition so screenshots,
remote play, overlays and the SDL presenter all observe the same pixels.

## Lua

Set `runtime.language` to `lua54-wasmcart`, place Lua under `app/`, and reuse
the checked-in wasmcart-lua `main.wasm`. This is genuine Lua 5.4 with the
LÖVE-shaped wasmcart graphics API, not a subset or transpiler. Its framebuffer
is the background composition and retroemu places the current game over it.
Use the raw C ABI for a package that needs live machine-region reads or writes.

See `examples/active-bezel/lua-starter`.

The reproducible CPU/GPU numbers and methodology are in
[ACTIVE_BEZEL_BENCHMARK.md](ACTIVE_BEZEL_BENCHMARK.md).

## Reference packages

- `diagnostic`: package/lifecycle/composition smoke test.
- `adventure-map`: live Atari 2600 room/player visualization, exact-ROM
  profile, and original packaging art in the right panel. Its `main.wasm` is
  genuinely compiled from `main.c` with Emscripten; rebuild it with
  `npm run build:active-bezel-adventure`. The current five-by-six room grid and
  X/Y marker transform demonstrate live state but are not yet a verified model
  of Adventure's actual world topology.
- `metroid2-map`: Game Boy mission telemetry, exact-ROM profile.
- `smb-expanded`: NES off-center expanded-scene experiment.
- `lua-starter`: reusable Lua authoring proof.

They contain no commercial ROM data. The Adventure development example now
does contain a copy of its commercial packaging artwork sourced from the
[Atari 2600 cartridge tour](https://2600adventures.atari.org/cartridge-tour.php);
it is a local integration demonstration, not a claim that the art is cleared
for redistribution. The other profiles identify the user-supplied ROM and read
its live state.

## Failure behavior

Invalid or mismatched packages fail before the game loop. A guest trap disables
only the bezel and immediately returns ordinary game video. Romdeck retains a
trusted disable operation outside guest control. Hot reload is transactional.
Normal sessions that do not attach a bezel do not instantiate this subsystem
and retain the pre-existing fast paths.
