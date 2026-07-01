#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/../build-core.sh" \
  fmsx \
  https://github.com/libretro/fmsx-libretro.git \
  Makefile
