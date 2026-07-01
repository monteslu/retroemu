#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/../build-core.sh" \
  prosystem \
  https://github.com/libretro/prosystem-libretro.git \
  Makefile
