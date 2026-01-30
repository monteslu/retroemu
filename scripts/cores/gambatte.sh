#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/../build-core.sh" \
  gambatte \
  https://github.com/libretro/gambatte-libretro.git \
  Makefile.libretro
