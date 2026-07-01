#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/../build-core.sh" \
  fceumm \
  https://github.com/libretro/libretro-fceumm.git \
  Makefile.libretro
