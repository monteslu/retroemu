# Lua Active Bezel Starter

This is AB-R4: real Lua 5.4 running in the reusable wasmcart-lua engine. Edit
only `app/main.lua`; `main.wasm` is the same prebuilt engine used by every Lua
package. The Lua framebuffer is composed first and the original game is placed
over it by the host, so the starter needs no native compiler.

The Lua adapter is intentionally the simple authoring tier in v1. C/Rust/etc.
guests use the raw ABI when they need named live regions, writes, or direct
command-list control.
