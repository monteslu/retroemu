#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/../build-core.sh" \
  vecx \
  https://github.com/libretro/libretro-vecx.git \
  Makefile.libretro
