#!/bin/bash
# mupen64plus-libretro-nx with Angrylion (software renderer) for N64
# GLideN64 still compiles but we select Angrylion at runtime via core options
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_DIR="$PROJECT_DIR/build/mupen64plus_next"
OUTPUT_DIR="$PROJECT_DIR/cores"

# Source emsdk
if [ -n "$EMSDK" ] && [ -f "$EMSDK/emsdk_env.sh" ]; then
  source "$EMSDK/emsdk_env.sh" > /dev/null 2>&1
fi

if ! command -v emcc &> /dev/null; then
  echo "Error: emcc not found"
  exit 1
fi

mkdir -p "$BUILD_DIR" "$OUTPUT_DIR"

# Clone if needed
if [ ! -d "$BUILD_DIR/src" ]; then
  echo "Cloning mupen64plus-libretro-nx..."
  git clone --depth 1 https://github.com/libretro/mupen64plus-libretro-nx.git "$BUILD_DIR/src"
fi

cd "$BUILD_DIR/src"

# Patch Makefile for emscripten compatibility:
# - -fno-common: wasm-ld doesn't support common symbols (tentative defs)
# - -fvisibility=default: emscripten defaults to hidden, we need default for cross-TU linking
# - Remove -fvisibility=hidden: same reason
# - PIC=0: -fPIC creates GOT-based accesses that break our separate link step
if ! grep -q "fno-common" Makefile; then
  echo "Patching Makefile for emscripten..."
  sed -i 's/-fcommon/-fno-common/g' Makefile
  sed -i 's/-fvisibility=hidden//g' Makefile
  sed -i 's/-fvisibility-inlines-hidden//g' Makefile
  # Add -fvisibility=default to emscripten CPUFLAGS
  sed -i 's/CPUFLAGS += -DEMSCRIPTEN -DNO_ASM/CPUFLAGS += -DEMSCRIPTEN -DNO_ASM -fvisibility=default/' Makefile
fi

echo "Building mupen64plus_next..."
emmake make -f Makefile platform=emscripten HAVE_THR_AL=1 PIC=0 clean 2>/dev/null || true
emmake make -f Makefile platform=emscripten HAVE_THR_AL=1 PIC=0 -j$(nproc)

# Collect all .o files and link with emcc directly (not via archive)
# The Makefile's em++ link produces a minimal JS+WASM without our exports.
OBJ_FILES=$(find . -name "*.o" | tr '\n' ' ')

EXPORTED_FUNCTIONS='["_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_malloc","_free"]'
EXPORTED_RUNTIME='["ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue","FS","dynCall"]'

echo "Linking mupen64plus_next WASM module..."
emcc $OBJ_FILES \
  -O2 \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s "EXPORT_NAME=create_mupen64plus_next" \
  -s ENVIRONMENT=node \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=134217728 \
  -s MAXIMUM_MEMORY=536870912 \
  -s STACK_SIZE=1048576 \
  -s ALLOW_TABLE_GROWTH=1 \
  -s EXPORTED_FUNCTIONS="$EXPORTED_FUNCTIONS" \
  -s EXPORTED_RUNTIME_METHODS="$EXPORTED_RUNTIME" \
  -s FILESYSTEM=1 \
  -s INVOKE_RUN=0 \
  -s USE_ZLIB=1 \
  -s USE_WEBGL2=1 \
  -s FULL_ES2=1 \
  -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
  -o "$OUTPUT_DIR/mupen64plus_next_libretro.js"

echo "Done: $OUTPUT_DIR/mupen64plus_next_libretro.js"
