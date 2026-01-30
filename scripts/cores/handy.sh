#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/../build-core.sh" \
  handy \
  https://github.com/libretro/libretro-handy.git \
  Makefile
