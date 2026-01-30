#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/../build-core.sh" \
  mgba \
  https://github.com/libretro/mgba.git \
  Makefile.libretro
