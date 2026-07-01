#!/bin/bash
# flycast: Sega Dreamcast emulator with GLES3 GPU rendering
# Based on nasomers/flycast-wasm patches applied to libretro/flycast
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_DIR="$PROJECT_DIR/build/flycast"
OUTPUT_DIR="$PROJECT_DIR/cores"
PATCHES_DIR="$BUILD_DIR/src/patches"
STUBS_DIR="$BUILD_DIR/src/stubs"

# Source emsdk
if [ -n "$EMSDK" ] && [ -f "$EMSDK/emsdk_env.sh" ]; then
  source "$EMSDK/emsdk_env.sh" > /dev/null 2>&1
fi

if ! command -v emcc &> /dev/null; then
  echo "Error: emcc not found"
  exit 1
fi

mkdir -p "$BUILD_DIR" "$OUTPUT_DIR"

# flycast-wasm repo (patches + stubs) should already be cloned at $BUILD_DIR/src
if [ ! -d "$PATCHES_DIR" ]; then
  echo "Error: flycast-wasm patches not found at $PATCHES_DIR"
  echo "Clone it: git clone --depth 1 https://github.com/nasomers/flycast-wasm.git $BUILD_DIR/src"
  exit 1
fi

# Clone libretro/flycast if needed
if [ ! -d "$BUILD_DIR/flycast" ]; then
  echo "Cloning libretro/flycast..."
  git clone --depth 1 https://github.com/libretro/flycast.git "$BUILD_DIR/flycast"
fi

cd "$BUILD_DIR/flycast"

# Apply patches if not already applied
if ! grep -q "HAVE_GENERIC_JIT" Makefile 2>/dev/null; then
  echo "Applying emscripten patches..."
  git apply "$PATCHES_DIR/flycast-all-changes.patch" || {
    echo "Patch may already be applied or needs manual merge"
  }
fi

# Build the core (compile only — we link ourselves)
echo "Building flycast..."
emmake make -f Makefile platform=emscripten clean 2>/dev/null || true
emmake make -f Makefile platform=emscripten -j$(nproc)

# Create static archive from .o files (Makefile links to .bc JS, we need .a)
echo "Creating static archive..."
CORE_LIB="flycast_core.a"
find . -name "*.o" -type f | sort > /tmp/flycast_objs.txt
emar rcs "$CORE_LIB" $(cat /tmp/flycast_objs.txt)

# Remove file_path.o from archive (conflicts with our stubs)
emar d "$CORE_LIB" core/libretro-common/file/file_path.o 2>/dev/null || true

echo "Archive: $CORE_LIB ($(du -h "$CORE_LIB" | cut -f1))"

# Compile stubs
echo "Compiling stubs..."
emcc -O3 -c "$STUBS_DIR/flycast_stubs.c" -o flycast_stubs.o
em++ -O3 -c "$STUBS_DIR/flycast_stubs_cpp.cpp" -o flycast_stubs_cpp.o

EXPORTED_FUNCTIONS='["_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_malloc","_free"]'
EXPORTED_RUNTIME='["ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue","FS","dynCall"]'

echo "Linking flycast WASM module..."
emcc "$CORE_LIB" flycast_stubs.o flycast_stubs_cpp.o \
  -O3 \
  -s WASM=1 \
  -s WASM_BIGINT \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s "EXPORT_NAME=create_flycast" \
  -s "ENVIRONMENT=node,web" \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=134217728 \
  -s MAXIMUM_MEMORY=2147483648 \
  -s STACK_SIZE=1048576 \
  -s ALLOW_TABLE_GROWTH=1 \
  -s EXPORTED_FUNCTIONS="$EXPORTED_FUNCTIONS" \
  -s EXPORTED_RUNTIME_METHODS="$EXPORTED_RUNTIME" \
  -s FILESYSTEM=1 \
  -s INVOKE_RUN=0 \
  -s FULL_ES3=1 \
  -s MIN_WEBGL_VERSION=2 \
  -s MAX_WEBGL_VERSION=2 \
  -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
  -s DISABLE_EXCEPTION_CATCHING=0 \
  -fexceptions \
  -o "$OUTPUT_DIR/flycast_libretro.js"

# Expose Emscripten's internal GL object on Module
echo "Patching Module.GL exposure..."
sed -i 's/var GL={/var GL=Module.GL={/' "$OUTPUT_DIR/flycast_libretro.js"

echo "Done: $OUTPUT_DIR/flycast_libretro.js"
ls -lh "$OUTPUT_DIR/flycast_libretro.js" "$OUTPUT_DIR/flycast_libretro.wasm"
