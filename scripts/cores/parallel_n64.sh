#!/bin/bash
# parallel-n64: Lighter N64 core with Glide64 graphics (fast in WASM)
# Based on the same core that N64Wasm uses for full-speed browser N64 emulation
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_DIR="$PROJECT_DIR/build/parallel_n64"
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
  echo "Cloning parallel-n64..."
  git clone --depth 1 https://github.com/libretro/parallel-n64.git "$BUILD_DIR/src"
fi

cd "$BUILD_DIR/src"

# Patch for emscripten compatibility
if ! grep -q "fno-common" Makefile; then
  echo "Patching Makefile for emscripten..."
  sed -i 's/-fvisibility=hidden//g' Makefile
  sed -i 's/-fvisibility-inlines-hidden//g' Makefile
fi

# Fix GLSM rglBlendFuncSeparate: upstream defines it with 2 args instead of 4,
# causing WASM unreachable trap on function signature mismatch
if grep -q "rglBlendFuncSeparate(GLenum sfactor, GLenum dfactor)" libretro-common/glsm/glsm.c; then
  echo "Patching GLSM rglBlendFuncSeparate (2 args -> 4 args)..."
  sed -i 's/void rglBlendFuncSeparate(GLenum sfactor, GLenum dfactor)/void rglBlendFuncSeparate(GLenum srcRGB, GLenum dstRGB, GLenum srcAlpha, GLenum dstAlpha)/' libretro-common/glsm/glsm.c
  sed -i '/rglBlendFuncSeparate.*srcRGB.*dstRGB.*srcAlpha.*dstAlpha/,/^}/ {
    s/gl_state\.blendfunc_separate\.srcRGB   = sfactor;/gl_state.blendfunc_separate.srcRGB   = srcRGB;/
    s/gl_state\.blendfunc_separate\.dstRGB   = dfactor;/gl_state.blendfunc_separate.dstRGB   = dstRGB;/
    s/glBlendFuncSeparate(sfactor, dfactor, sfactor, dfactor);/glBlendFuncSeparate(srcRGB, dstRGB, srcAlpha, dstAlpha);/
  }' libretro-common/glsm/glsm.c
fi

echo "Building parallel_n64..."
emmake make -f Makefile platform=emscripten HAVE_THR_AL=1 clean 2>/dev/null || true
emmake make -f Makefile platform=emscripten HAVE_THR_AL=1 -j$(nproc)

# Compile libretro-common files that the Makefile misses for emscripten
echo "Compiling extra libretro-common files..."
INCLUDES="-I./libretro-common/include -I./mupen64plus-core/src -I./mupen64plus-core/src/api -I./libretro"
DEFINES="-DNDEBUG -DNO_ASM -DNOSSE -DEMSCRIPTEN -DSINC_LOWER_QUALITY"
EXTRAS=(
  libretro-common/audio/resampler/audio_resampler.c
  libretro-common/audio/resampler/drivers/sinc_resampler.c
  libretro-common/audio/resampler/drivers/nearest_resampler.c
  libretro-common/audio/resampler/drivers/null_resampler.c
  libretro-common/audio/conversion/float_to_s16.c
  libretro-common/audio/conversion/s16_to_float.c
  libretro-common/gfx/gl_capabilities.c
  libretro-common/features/features_cpu.c
  libretro-common/file/config_file.c
  libretro-common/file/config_file_userdata.c
  libretro-common/file/file_path.c
  libretro-common/lists/string_list.c
  libretro-common/string/stdstring.c
  libretro-common/compat/compat_strl.c
  libretro-common/compat/compat_posix_string.c
  libretro-common/compat/compat_strcasestr.c
  libretro-common/compat/compat_snprintf.c
  libretro-common/encodings/encoding_utf.c
  libretro-common/vfs/vfs_implementation.c
  libretro-common/streams/file_stream.c
)
for src in "${EXTRAS[@]}"; do
  obj="${src%.c}.o"
  if [ ! -f "$obj" ]; then
    emcc -O3 -flto -c "$src" -o "$obj" $INCLUDES $DEFINES -DHAVE_OPENGLES -DHAVE_OPENGLES2
  fi
done

# Collect all .o files and link with emcc
OBJ_FILES=$(find . -name "*.o" | tr '\n' ' ')

EXPORTED_FUNCTIONS='["_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_malloc","_free"]'
EXPORTED_RUNTIME='["ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue","FS","dynCall"]'

echo "Linking parallel_n64 WASM module..."
emcc $OBJ_FILES \
  -O3 \
  -flto \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s "EXPORT_NAME=create_parallel_n64" \
  -s "ENVIRONMENT=node,web" \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=167772160 \
  -s MAXIMUM_MEMORY=536870912 \
  -s STACK_SIZE=1048576 \
  -s ALLOW_TABLE_GROWTH=1 \
  -s EXPORTED_FUNCTIONS="$EXPORTED_FUNCTIONS" \
  -s EXPORTED_RUNTIME_METHODS="$EXPORTED_RUNTIME" \
  -s FILESYSTEM=1 \
  -s INVOKE_RUN=0 \
  -s USE_ZLIB=1 \
  -s MIN_WEBGL_VERSION=2 \
  -s FULL_ES3=1 \
  -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
  -o "$OUTPUT_DIR/parallel_n64_libretro.js"

# Expose Emscripten's internal GL object on Module so we can call
# GL.createContext() / GL.makeContextCurrent() from outside the closure
echo "Patching Module.GL exposure..."
sed -i 's/var GL={/var GL=Module.GL={/' "$OUTPUT_DIR/parallel_n64_libretro.js"

echo "Done: $OUTPUT_DIR/parallel_n64_libretro.js"
ls -lh "$OUTPUT_DIR/parallel_n64_libretro.js" "$OUTPUT_DIR/parallel_n64_libretro.wasm"
