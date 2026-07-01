#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/../build-core.sh" \
  beetle_pce_fast \
  https://github.com/libretro/beetle-pce-fast-libretro.git \
  Makefile
