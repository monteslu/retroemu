#!/bin/bash
# Build script for vice_x64 (Commodore 64)
# Vice uses its main Makefile with EMUTYPE parameter, not Makefile.libretro

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_DIR="$PROJECT_DIR/build/vice_x64"
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
  echo "Cloning vice_x64 from https://github.com/libretro/vice-libretro.git..."
  git clone --depth 1 "https://github.com/libretro/vice-libretro.git" "$BUILD_DIR/src"
fi

# Build the core with emscripten
echo "Building vice_x64..."
cd "$BUILD_DIR/src"
emmake make platform=emscripten EMUTYPE=x64 clean 2>/dev/null || true
emmake make platform=emscripten EMUTYPE=x64 -j"$(nproc)"

# Find the built output
CORE_LIB=$(find . -maxdepth 2 \( -name "vice_x64*.a" -o -name "vice_x64*_libretro_emscripten.bc" \) | head -1)

if [ -z "$CORE_LIB" ]; then
  echo "Error: Could not find compiled core library for vice_x64"
  exit 1
fi

echo "Found core library: $CORE_LIB"

# Check if the file is an archive (starts with !<arch>) or a linked output
IS_ARCHIVE=false
if head -c 7 "$CORE_LIB" | grep -q '!<arch>'; then
  IS_ARCHIVE=true
fi

# If it's a .bc archive created by emar, rename to .a
if [[ "$CORE_LIB" == *.bc ]] && [ "$IS_ARCHIVE" = true ]; then
  CORE_LIB_A="${CORE_LIB%.bc}.a"
  mv "$CORE_LIB" "$CORE_LIB_A"
  CORE_LIB="$CORE_LIB_A"
  echo "Renamed archive to: $CORE_LIB"
fi

# If it's not an archive, error out
if [ "$IS_ARCHIVE" = false ]; then
  echo "Error: Build produced a linked output instead of an archive."
  exit 1
fi

# Exported libretro API functions
EXPORTED_FUNCTIONS='["_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_malloc","_free"]'

EXPORTED_RUNTIME='["ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue"]'

echo "Linking vice_x64 WASM module..."
emcc "$CORE_LIB" \
  -O3 \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s "EXPORT_NAME=create_vice_x64" \
  -s ENVIRONMENT=node \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=67108864 \
  -s MAXIMUM_MEMORY=536870912 \
  -s ALLOW_TABLE_GROWTH=1 \
  -s EXPORTED_FUNCTIONS="$EXPORTED_FUNCTIONS" \
  -s EXPORTED_RUNTIME_METHODS="$EXPORTED_RUNTIME" \
  -s FILESYSTEM=0 \
  -s INVOKE_RUN=0 \
  -s USE_ZLIB=1 \
  -o "$OUTPUT_DIR/vice_x64_libretro.js"

echo "Built vice_x64 -> $OUTPUT_DIR/vice_x64_libretro.js + .wasm"
echo "Done."
