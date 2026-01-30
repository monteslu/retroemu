#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/../build-core.sh" \
  pcsx_rearmed \
  https://github.com/libretro/pcsx_rearmed.git \
  Makefile.libretro \
  "-s INITIAL_MEMORY=134217728"
