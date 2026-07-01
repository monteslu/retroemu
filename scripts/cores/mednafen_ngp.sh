#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/../build-core.sh" \
  mednafen_ngp \
  https://github.com/libretro/beetle-ngp-libretro.git \
  Makefile
