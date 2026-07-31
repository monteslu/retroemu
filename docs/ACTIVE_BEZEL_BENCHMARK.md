# Active Bezel compositor benchmark

Measured 2026-07-30 on the development Linux host with
`npm run benchmark:active-bezel`. The scene contains a changing 256×240 game
texture, 24 rectangles, and a translucent triangle. Five warm-up frames are
excluded.

| Backend | Internal target | Frames | Mean |
|---|---:|---:|---:|
| CPU command fallback | 640×360 | 120 | 1.33 ms |
| OpenGL ES 3 command renderer | 640×360 | 120 | 0.58 ms |
| CPU command fallback | 1920×1080 | 30 | 11.87 ms |
| OpenGL ES 3 command renderer | 1920×1080 | 30 | 3.06 ms |

The GPU number includes synchronous RGBA readback of the final composite,
which is the pessimistic path required when screenshots, recording, terminal
output, or remote play need CPU-visible pixels. Direct SDL presentation can
avoid an additional scale in hardware. Results are not a cross-machine
promise; the checked-in benchmark is the regression instrument.

The practical default for reference packages is therefore a 640×360 internal
canvas scaled to 1080p or 4K by the presentation layer. Authors can select a
higher internal resolution when fine text or dense map information justifies
the bandwidth.
