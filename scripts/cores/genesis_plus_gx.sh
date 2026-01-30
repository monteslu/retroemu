#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/../build-core.sh" \
  genesis_plus_gx \
  https://github.com/libretro/Genesis-Plus-GX.git \
  Makefile.libretro
