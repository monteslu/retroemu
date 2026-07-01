#!/bin/bash
set -e

CORE_NAME=$1
CORE_REPO=$2
CORE_MAKEFILE=${3:-Makefile.libretro}
EXTRA_FLAGS=${4:-}

if [ -z "$CORE_NAME" ] || [ -z "$CORE_REPO" ]; then
  echo "Usage: build-core.sh <core-name> <git-repo-url> [makefile] [extra-emcc-flags]"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$PROJECT_DIR/build/$CORE_NAME"
OUTPUT_DIR="$PROJECT_DIR/cores"

# Source emsdk if available
if [ -n "$EMSDK" ] && [ -f "$EMSDK/emsdk_env.sh" ]; then
  source "$EMSDK/emsdk_env.sh" > /dev/null 2>&1
fi

# Verify emcc is available
if ! command -v emcc &> /dev/null; then
  echo "Error: emcc not found. Install and activate the Emscripten SDK first."
  echo "  git clone https://github.com/emscripten-core/emsdk.git"
  echo "  cd emsdk && ./emsdk install latest && ./emsdk activate latest"
  exit 1
fi

mkdir -p "$BUILD_DIR" "$OUTPUT_DIR"

# Clone core source if not present
if [ ! -d "$BUILD_DIR/src" ]; then
  echo "Cloning $CORE_NAME from $CORE_REPO..."
  git clone --depth 1 "$CORE_REPO" "$BUILD_DIR/src"
fi

# Build the core with emscripten
echo "Building $CORE_NAME..."
cd "$BUILD_DIR/src"
emmake make -f "$CORE_MAKEFILE" platform=emscripten clean 2>/dev/null || true
emmake make -f "$CORE_MAKEFILE" platform=emscripten -j"$(nproc)"

# Find the built output (.a or .bc file)
CORE_LIB=$(find . -maxdepth 2 \( -name "*.a" -o -name "*_libretro_emscripten.bc" -o -name "*_libretro.bc" \) | head -1)

if [ -z "$CORE_LIB" ]; then
  echo "Error: Could not find compiled core library for $CORE_NAME"
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

# If it's not an archive, error out - we need an archive for proper linking
if [ "$IS_ARCHIVE" = false ]; then
  echo "Error: Build produced a linked output instead of an archive."
  echo "This core may need a custom build script."
  exit 1
fi

# Find libretro-common directory
LIBRETRO_COMMON=""
for dir in "libretro-common" "src/libretro-common" "libretro/libretro-common" "src/drivers/libretro/libretro-common" "libgambatte/libretro-common"; do
  if [ -d "$dir" ]; then
    LIBRETRO_COMMON="$dir"
    break
  fi
done

# Fallback: search for libretro-common anywhere
if [ -z "$LIBRETRO_COMMON" ]; then
  LIBRETRO_COMMON=$(find . -maxdepth 4 -type d -name "libretro-common" | head -1)
fi

# Check if we need to add libretro-common (check if memory_stream symbol is missing)
if [ -n "$LIBRETRO_COMMON" ]; then
  # Check archive contents for missing symbols using nm
  if ! emar -t "$CORE_LIB" 2>/dev/null | grep -q "memory_stream"; then
    echo "Adding libretro-common sources from: $LIBRETRO_COMMON"

    # Compile needed libretro-common sources
    COMMON_OBJS=""
    INCLUDE_FLAGS="-I$LIBRETRO_COMMON/include"

    for src in \
      "$LIBRETRO_COMMON/compat/compat_strl.c" \
      "$LIBRETRO_COMMON/compat/compat_posix_string.c" \
      "$LIBRETRO_COMMON/compat/compat_strcasestr.c" \
      "$LIBRETRO_COMMON/compat/compat_snprintf.c" \
      "$LIBRETRO_COMMON/compat/fopen_utf8.c" \
      "$LIBRETRO_COMMON/encodings/encoding_utf.c" \
      "$LIBRETRO_COMMON/encodings/encoding_crc32.c" \
      "$LIBRETRO_COMMON/file/file_path.c" \
      "$LIBRETRO_COMMON/file/file_path_io.c" \
      "$LIBRETRO_COMMON/streams/file_stream.c" \
      "$LIBRETRO_COMMON/streams/file_stream_transforms.c" \
      "$LIBRETRO_COMMON/streams/memory_stream.c" \
      "$LIBRETRO_COMMON/streams/interface_stream.c" \
      "$LIBRETRO_COMMON/string/stdstring.c" \
      "$LIBRETRO_COMMON/time/rtime.c" \
      "$LIBRETRO_COMMON/lists/string_list.c" \
      "$LIBRETRO_COMMON/lists/dir_list.c" \
      "$LIBRETRO_COMMON/file/retro_dirent.c" \
      "$LIBRETRO_COMMON/vfs/vfs_implementation.c"
    do
      if [ -f "$src" ]; then
        obj="${src%.c}.o"
        echo "  Compiling $(basename $src)..."
        emcc -c -O2 $INCLUDE_FLAGS -D__LIBRETRO__ -o "$obj" "$src" 2>/dev/null || true
        if [ -f "$obj" ]; then
          COMMON_OBJS="$COMMON_OBJS $obj"
        fi
      fi
    done

    # Add objects to archive
    if [ -n "$COMMON_OBJS" ]; then
      echo "Adding objects to archive..."
      emar rcs "$CORE_LIB" $COMMON_OBJS
    fi
  else
    echo "libretro-common already included in archive"
  fi
fi

# Exported libretro API functions
EXPORTED_FUNCTIONS='["_retro_api_version","_retro_init","_retro_deinit","_retro_set_environment","_retro_set_video_refresh","_retro_set_audio_sample","_retro_set_audio_sample_batch","_retro_set_input_poll","_retro_set_input_state","_retro_get_system_info","_retro_get_system_av_info","_retro_load_game","_retro_unload_game","_retro_run","_retro_reset","_retro_serialize_size","_retro_serialize","_retro_unserialize","_retro_get_memory_data","_retro_get_memory_size","_retro_get_region","_retro_set_controller_port_device","_malloc","_free"]'

EXPORTED_RUNTIME='["ccall","cwrap","addFunction","removeFunction","HEAPU8","HEAPU16","HEAPU32","HEAP16","HEAP32","HEAPF32","UTF8ToString","stringToUTF8","lengthBytesUTF8","getValue","setValue","FS"]'

echo "Linking $CORE_NAME WASM module..."
emcc "$CORE_LIB" \
  -O3 \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s "EXPORT_NAME=create_${CORE_NAME}" \
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
  $EXTRA_FLAGS \
  -o "$OUTPUT_DIR/${CORE_NAME}_libretro.js"

echo "Built $CORE_NAME -> $OUTPUT_DIR/${CORE_NAME}_libretro.js + .wasm"
echo "Done."
