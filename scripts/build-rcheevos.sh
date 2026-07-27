#!/usr/bin/env bash
# Build rcheevos' ACHIEVEMENT RUNTIME to WASM, from upstream sources.
#
# WHY THIS EXISTS
#
# romdeck could already LIST a game's achievements (the RetroAchievements web
# API, read-only). Actually UNLOCKING one while you play needs rcheevos'
# condition evaluator running against core memory every frame.
#
# The published `rcheevos` npm package cannot do that. It is hash-only — its
# README says "Currently only supports the rhash namespace, for hashing ROM
# files", and the shipped .wasm exports 9 symbols, none of them rc_runtime_*.
# No published WASM build of the evaluator exists anywhere, so romdeck builds
# one, the same way it builds the H.264 snap decoder and the way romdev builds
# every emulator core: upstream is FETCHED and pinned, never vendored, and the
# artifact is a .wasm the app loads.
#
# NOT a native addon. WASM is the whole point of this project: one .wasm runs
# on x86_64 Linux, Apple Silicon, a Steam Deck and an ARM handheld with no
# build matrix, no per-platform CI, and no compiler on the user's machine.
#
# SCOPE
#
# rc_runtime, not rc_client. rc_runtime is the pure evaluator: give it an
# achievement's memaddr string and a peek callback, and it tells you when the
# conditions trigger. rc_client is a much larger thing that also owns HTTP,
# login, sessions and its own scheduling — romdeck already has all of that in
# src/services/retroachievements.js, and pulling in a second network stack
# that we then have to hold WASM-side would be strictly worse.
#
# So this compiles src/rcheevos/*.c plus the two support files it needs, and
# nothing from rapi/ (HTTP request building) or rhash/ (ROM hashing — the npm
# package already does that well and we use it).
#
# Output: src/cheevos/wasm/rcheevos.{js,wasm}
set -euo pipefail

# Pinned. An achievement's logic is a string compiled by this evaluator, so a
# silent upstream change is a silent change in whether achievements trigger.
RCHEEVOS_REF="${RCHEEVOS_REF:-v12.4.0}"
BUILD_DIR="${BUILD_DIR:-$HOME/.cache/retroemu-build}"
SRC="$BUILD_DIR/rcheevos"
RETROEMU="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$RETROEMU/src/cheevos/wasm"

command -v emcc >/dev/null || {
  echo "FATAL: emcc not found. Activate emsdk first:" >&2
  echo "  source ~/code/cliemu/emsdk/emsdk_env.sh" >&2
  exit 1
}
command -v git >/dev/null || { echo "FATAL: git required" >&2; exit 1; }

mkdir -p "$BUILD_DIR" "$OUT"

if [ ! -d "$SRC" ]; then
  echo "Fetching rcheevos $RCHEEVOS_REF (shallow) …"
  git clone --depth 1 --branch "$RCHEEVOS_REF" \
    https://github.com/RetroAchievements/rcheevos.git "$SRC"
fi

cd "$SRC"
echo "rcheevos $(git describe --tags --always)"

# The evaluator and what it depends on. Deliberately NOT rapi/ or rhash/.
SOURCES=(
  src/rcheevos/alloc.c
  src/rcheevos/condition.c
  src/rcheevos/condset.c
  src/rcheevos/consoleinfo.c
  src/rcheevos/format.c
  src/rcheevos/lboard.c
  src/rcheevos/memref.c
  src/rcheevos/operand.c
  src/rcheevos/rc_validate.c
  src/rcheevos/richpresence.c
  src/rcheevos/runtime.c
  src/rcheevos/runtime_progress.c
  src/rcheevos/trigger.c
  src/rcheevos/value.c
  src/rc_compat.c
  src/rc_util.c
  src/rc_version.c
  # From rhash/, but ONLY this one file: runtime_progress.c checksums its
  # serialized state with md5, so the evaluator does not link without it.
  # md5.c is self-contained (its own header, stddef, string.h) and pulls in
  # none of the ROM-hashing machinery around it.
  src/rhash/md5.c
)

# addFunction is how the peek callback and the event handler get from JS into
# C: rc_runtime_do_frame takes two function POINTERS, so the JS side has to be
# able to mint them. Without ALLOW_TABLE_GROWTH those slots cannot be created.
echo "Compiling …"
emcc \
  -O3 \
  -I include -I src -I src/rcheevos -I src/rhash \
  "${SOURCES[@]}" \
  -o "$OUT/rcheevos.js" \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createRcheevos \
  -s ENVIRONMENT=node,web \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s ALLOW_TABLE_GROWTH=1 \
  -s FILESYSTEM=0 \
  -s EXPORTED_RUNTIME_METHODS='["addFunction","removeFunction","getValue","setValue","UTF8ToString","stringToUTF8","lengthBytesUTF8","HEAPU8","HEAP32"]' \
  -s EXPORTED_FUNCTIONS='["_malloc","_free","_rc_runtime_init","_rc_runtime_destroy","_rc_runtime_activate_achievement","_rc_runtime_deactivate_achievement","_rc_runtime_do_frame","_rc_runtime_reset","_rc_runtime_get_achievement","_rc_runtime_progress_size","_rc_runtime_serialize_progress_sized","_rc_runtime_deserialize_progress_sized","_rc_version_string"]'

echo
ls -la "$OUT"/rcheevos.js "$OUT"/rcheevos.wasm
echo
echo "Built rcheevos runtime → $OUT/rcheevos.{js,wasm}"
echo "  scope: rc_runtime evaluator only (no rapi HTTP, no rhash)"
