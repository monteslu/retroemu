# TODO

## Heavier Cores to Add

These systems have larger/more complex cores that may need additional work:

| System | Core | Notes |
|--------|------|-------|
| Virtual Boy | mednafen_vb | Nintendo's 3D handheld (1995). Red/black display - interesting terminal rendering challenge |
| Sega 32X | picodrive | Genesis add-on. May need to coordinate with genesis_plus_gx |
| PlayStation | pcsx_rearmed | Requires BIOS files. Large core, may have memory issues in WASM |
| Nintendo DS | desmume / melonDS | Dual screens, touch input. Very heavy cores |
| Sega CD | genesis_plus_gx | Already have the core, just needs BIOS files and `.cue`/`.chd` support |
| Commodore 64 | vice_x64 | Complex VFS dependencies. Build fails with missing libretro VFS symbols (rfseek, rfgetc, etc.) |

## Other Potential Additions

- **Arcade** (FinalBurn Neo / MAME) - Complex, ROM sets are large
- **Nintendo 64** (mupen64plus / parallel-n64) - Very heavy, may not work well in WASM
- **Sega Saturn** (mednafen_saturn / yabause) - Heavy, needs BIOS
- **3DO** (opera) - Needs BIOS
- **Jaguar** (virtualjaguar) - Atari's 64-bit console
