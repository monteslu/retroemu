#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/../build-core.sh" \
  mednafen_wswan \
  https://github.com/libretro/beetle-wswan-libretro.git \
  Makefile
