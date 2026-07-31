#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "$script_dir/.." && pwd)"
emcc_bin="${EMCC:-emcc}"

"$emcc_bin" \
  "$project_dir/examples/active-bezel/adventure-map/main.c" \
  -I "$project_dir/sdk/active-bezel" \
  -O2 \
  -nostdlib \
  -Wl,--no-entry \
  -Wl,--allow-undefined \
  -Wl,--strip-all \
  -o "$project_dir/examples/active-bezel/adventure-map/main.wasm"

echo "Built examples/active-bezel/adventure-map/main.wasm from main.c"
