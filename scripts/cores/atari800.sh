#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/../build-core.sh" \
  atari800 \
  https://github.com/libretro/libretro-atari800.git \
  Makefile
