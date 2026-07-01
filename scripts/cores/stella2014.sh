#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/../build-core.sh" \
  stella2014 \
  https://github.com/libretro/stella2014-libretro.git \
  Makefile
