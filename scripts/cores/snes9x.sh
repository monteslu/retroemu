#!/bin/bash
# snes9x has its Makefile in libretro/ subdirectory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_DIR="$PROJECT_DIR/build/snes9x"
OUTPUT_DIR="$PROJECT_DIR/cores"

# Source emsdk
if [ -n "$EMSDK" ] && [ -f "$EMSDK/emsdk_env.sh" ]; then
  source "$EMSDK/emsdk_env.sh" > /dev/null 2>&1
fi

mkdir -p "$BUILD_DIR" "$OUTPUT_DIR"

# Clone if needed
if [ ! -d "$BUILD_DIR/src" ]; then
  echo "Cloning snes9x..."
  git clone --depth 1 https://github.com/libretro/snes9x.git "$BUILD_DIR/src"
fi

# Build from libretro subdirectory
echo "Building snes9x..."
cd "$BUILD_DIR/src/libretro"
emmake make platform=emscripten clean 2>/dev/null || true
emmake make platform=emscripten -j$(nproc)

# Find the output
CORE_LIB=$(find . -maxdepth 1 \( -name "*.a" -o -name "*_libretro*.bc" \) | head -1)
if [ -z "$CORE_LIB" ]; then
  echo "Error: Could not find compiled core"
  exit 1
fi

echo "Found: $CORE_LIB"

# If .bc file is actually an archive, rename to .a
if [[ "$CORE_LIB" == *.bc ]]; then
  if head -c 7 "$CORE_LIB" | grep -q '!<arch>'; then
    mv "$CORE_LIB" "${CORE_LIB%.bc}.a"
    CORE_LIB="${CORE_LIB%.bc}.a"
    echo "Renamed archive to: $CORE_LIB"
  fi
fi

# Link to WASM
EXPORTED_FUNCTIONS='["_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_malloc","_free"]'
EXPORTED_RUNTIME='["ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue","FS"]'

echo "Linking WASM..."
emcc "$CORE_LIB" \
  -O3 \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s "EXPORT_NAME=create_snes9x" \
  -s ENVIRONMENT=node \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=33554432 \
  -s MAXIMUM_MEMORY=268435456 \
  -s ALLOW_TABLE_GROWTH=1 \
  -s EXPORTED_FUNCTIONS="$EXPORTED_FUNCTIONS" \
  -s EXPORTED_RUNTIME_METHODS="$EXPORTED_RUNTIME" \
  -s FILESYSTEM=1 \
  -s INVOKE_RUN=0 \
  -s USE_ZLIB=1 \
  -o "$OUTPUT_DIR/snes9x_libretro.js"

echo "Done: $OUTPUT_DIR/snes9x_libretro.js"
