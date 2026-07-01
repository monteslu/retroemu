#!/bin/bash
# beetle_psx_hw: PlayStation 1 with hardware OpenGL renderer
# Uses mednafen_psx_hw core with GLES3 GPU rendering
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_DIR="$PROJECT_DIR/build/beetle_psx_hw"
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
  echo "Cloning beetle-psx-libretro..."
  git clone --depth 1 https://github.com/libretro/beetle-psx-libretro.git "$BUILD_DIR/src"
fi

cd "$BUILD_DIR/src"

echo "Building beetle_psx_hw (OpenGL HW renderer)..."
emmake make -f Makefile platform=emscripten HAVE_OPENGL=1 clean 2>/dev/null || true
emmake make -f Makefile platform=emscripten HAVE_OPENGL=1 -j$(nproc)

# Find the built output
CORE_LIB=$(find . -maxdepth 2 \( -name "*.a" -o -name "*_libretro_emscripten.bc" -o -name "*_libretro.bc" -o -name "*.bc" \) | head -1)

if [ -z "$CORE_LIB" ]; then
  echo "Error: Could not find compiled core library"
  exit 1
fi

echo "Found core library: $CORE_LIB"

# Compile missing libretro-common sources
echo "Compiling extra libretro-common files..."
LC_INCLUDES="-I./libretro-common/include"
LC_DEFINES="-DEMSCRIPTEN -D__LIBRETRO__ -DNDEBUG"
LC_EXTRAS=(
  libretro-common/streams/file_stream.c
  libretro-common/vfs/vfs_implementation.c
  libretro-common/file/file_path.c
  libretro-common/file/file_path_io.c
  libretro-common/compat/compat_strl.c
  libretro-common/string/stdstring.c
  libretro-common/encodings/encoding_utf.c
  libretro-common/hash/rhash.c
)
for src in "${LC_EXTRAS[@]}"; do
  if [ -f "$src" ]; then
    obj="${src%.c}.o"
    if [ ! -f "$obj" ]; then
      emcc -O3 -c "$src" -o "$obj" $LC_INCLUDES $LC_DEFINES 2>/dev/null || true
    fi
    if [ -f "$obj" ]; then
      emar rcs "$CORE_LIB" "$obj"
    fi
  fi
done

# If it's a .bc archive, rename to .a for emcc
IS_ARCHIVE=false
if head -c 7 "$CORE_LIB" | grep -q '!<arch>'; then
  IS_ARCHIVE=true
fi

if [[ "$CORE_LIB" == *.bc ]] && [ "$IS_ARCHIVE" = true ]; then
  CORE_LIB_A="${CORE_LIB%.bc}.a"
  mv "$CORE_LIB" "$CORE_LIB_A"
  CORE_LIB="$CORE_LIB_A"
  echo "Renamed archive to: $CORE_LIB"
fi

EXPORTED_FUNCTIONS='["_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_malloc","_free"]'
EXPORTED_RUNTIME='["ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue","FS","dynCall"]'

echo "Linking beetle_psx_hw WASM module..."
emcc "$CORE_LIB" \
  -O3 \
  -flto \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s "EXPORT_NAME=create_beetle_psx_hw" \
  -s "ENVIRONMENT=node,web" \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=536870912 \
  -s MAXIMUM_MEMORY=1073741824 \
  -s STACK_SIZE=1048576 \
  -s ALLOW_TABLE_GROWTH=1 \
  -s EXPORTED_FUNCTIONS="$EXPORTED_FUNCTIONS" \
  -s EXPORTED_RUNTIME_METHODS="$EXPORTED_RUNTIME" \
  -s FILESYSTEM=1 \
  -s INVOKE_RUN=0 \
  -s USE_ZLIB=1 \
  -s MIN_WEBGL_VERSION=2 \
  -s MAX_WEBGL_VERSION=2 \
  -s FULL_ES3=1 \
  -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
  -o "$OUTPUT_DIR/beetle_psx_hw_libretro.js"

# Expose Emscripten's internal GL object on Module
echo "Patching Module.GL exposure..."
sed -i 's/var GL={/var GL=Module.GL={/' "$OUTPUT_DIR/beetle_psx_hw_libretro.js"

echo "Done: $OUTPUT_DIR/beetle_psx_hw_libretro.js"
ls -lh "$OUTPUT_DIR/beetle_psx_hw_libretro.js" "$OUTPUT_DIR/beetle_psx_hw_libretro.wasm"
