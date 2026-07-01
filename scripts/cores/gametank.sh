#!/bin/bash
# GameTank (Clyde Shaffer's open 8-bit console). Unlike the upstream-libretro
# cores, this one isn't a git-repo + Makefile.libretro emscripten build — it's
# monteslu's gametank-libretro core, which has its own `make platform=retroemu`
# target that emits the MODULARIZE+ES6 factory retroemu expects. So we don't use
# build-core.sh; we clone our repo, run that target, and copy the pair in.
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CORES_DIR="$SCRIPT_DIR/../../cores"
REPO="https://github.com/monteslu/gametank-libretro.git"
REF="${GAMETANK_REF:-v0.1.1}"   # pin a released tag; override with GAMETANK_REF
BUILD="$SCRIPT_DIR/../../build/gametank"

if ! command -v emcc >/dev/null 2>&1; then
  echo "Error: emcc not found — activate the Emscripten SDK first." >&2
  exit 1
fi

echo "Building gametank core from $REPO @ $REF ..."
rm -rf "$BUILD"
git clone --depth 1 --branch "$REF" "$REPO" "$BUILD"
make -C "$BUILD" platform=retroemu

cp "$BUILD/gametank_libretro.js" "$BUILD/gametank_libretro.wasm" "$CORES_DIR/"
echo "✓ gametank_libretro.{js,wasm} -> $CORES_DIR"
