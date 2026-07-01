#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Building all libretro cores ==="

for core_script in "$SCRIPT_DIR/cores/"*.sh; do
  if [ -f "$core_script" ]; then
    echo ""
    echo "--- Running $(basename "$core_script") ---"
    bash "$core_script"
  fi
done

echo ""
echo "=== All cores built ==="
