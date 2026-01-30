#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/../build-core.sh" \
  snes9x2010 \
  https://github.com/libretro/snes9x2010.git \
  Makefile.libretro
