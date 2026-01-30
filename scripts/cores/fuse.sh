#!/bin/bash
# Custom build script for fuse (ZX Spectrum)
# The standard emscripten target produces a linked .bc file instead of an archive
# Force STATIC_LINKING=1 to get an archive that can be linked with our standard process

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_DIR="$PROJECT_DIR/build/fuse"
OUTPUT_DIR="$PROJECT_DIR/cores"

# Source emsdk if available
if [ -n "$EMSDK" ] && [ -f "$EMSDK/emsdk_env.sh" ]; then
  source "$EMSDK/emsdk_env.sh" > /dev/null 2>&1
fi

# Verify emcc is available
if ! command -v emcc &> /dev/null; then
  echo "Error: emcc not found. Install and activate the Emscripten SDK first."
  exit 1
fi

mkdir -p "$BUILD_DIR" "$OUTPUT_DIR"

# Clone core source if not present
if [ ! -d "$BUILD_DIR/src" ]; then
  echo "Cloning fuse from https://github.com/libretro/fuse-libretro.git..."
  git clone --depth 1 "https://github.com/libretro/fuse-libretro.git" "$BUILD_DIR/src"
fi

# Build the core with emscripten, forcing STATIC_LINKING=1 to get an archive
echo "Building fuse..."
cd "$BUILD_DIR/src"
emmake make -f Makefile.libretro platform=emscripten STATIC_LINKING=1 clean 2>/dev/null || true
emmake make -f Makefile.libretro platform=emscripten STATIC_LINKING=1 -j"$(nproc)"

# The output should now be an archive
CORE_LIB=$(find . -maxdepth 2 \( -name "*.a" -o -name "*_libretro_emscripten.a" \) | head -1)

# Fall back to .bc if needed and check if it's really an archive
if [ -z "$CORE_LIB" ]; then
  CORE_LIB=$(find . -maxdepth 2 -name "*_libretro_emscripten.bc" | head -1)
  if [ -n "$CORE_LIB" ] && head -c 7 "$CORE_LIB" | grep -q '!<arch>'; then
    # It's an archive with .bc extension, rename it
    CORE_LIB_A="${CORE_LIB%.bc}.a"
    mv "$CORE_LIB" "$CORE_LIB_A"
    CORE_LIB="$CORE_LIB_A"
    echo "Renamed archive to: $CORE_LIB"
  fi
fi

if [ -z "$CORE_LIB" ]; then
  echo "Error: Could not find compiled core library for fuse"
  exit 1
fi

echo "Found core library: $CORE_LIB"

# Verify it's an archive
if ! head -c 7 "$CORE_LIB" | grep -q '!<arch>'; then
  echo "Error: Build produced a linked output instead of an archive."
  exit 1
fi

# Exported libretro API functions
EXPORTED_FUNCTIONS='["_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_malloc","_free"]'

EXPORTED_RUNTIME='["ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue"]'

echo "Linking fuse WASM module..."
emcc "$CORE_LIB" \
  -O3 \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s "EXPORT_NAME=create_fuse" \
  -s ENVIRONMENT=node \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=33554432 \
  -s MAXIMUM_MEMORY=268435456 \
  -s ALLOW_TABLE_GROWTH=1 \
  -s EXPORTED_FUNCTIONS="$EXPORTED_FUNCTIONS" \
  -s EXPORTED_RUNTIME_METHODS="$EXPORTED_RUNTIME" \
  -s FILESYSTEM=0 \
  -s INVOKE_RUN=0 \
  -s USE_ZLIB=1 \
  -o "$OUTPUT_DIR/fuse_libretro.js"

echo "Built fuse -> $OUTPUT_DIR/fuse_libretro.js + .wasm"
echo "Done."
