#ifndef ACTIVE_BEZEL_H
#define ACTIVE_BEZEL_H

#include <stdint.h>

/* ABI 2 adds the optional pre_render hook + input_override. A guest that
 * uses NEITHER may keep reporting 1 from ab_abi_version and stays loadable
 * on old hosts; a guest that imports input_override or exports ab_pre_render
 * must report 2 so an old host refuses it LOUDLY at load instead of running
 * it with the hook silently never called. */
#define AB_ABI_VERSION 2
#define AB_LOGICAL_WIDTH 1920
#define AB_LOGICAL_HEIGHT 1080
#define AB_REGION_READ 1u
#define AB_REGION_WRITE 2u
#define AB_REGION_VOLATILE 4u
#define AB_REGION_ROM 8u
#define AB_SAMPLE_NEAREST 0
#define AB_SAMPLE_LINEAR 1
#define AB_FIT_CONTAIN 0
#define AB_FIT_COVER 1
#define AB_FIT_STRETCH 2
#define AB_FIT_INTEGER 3
#define AB_DEVICE_JOYPAD 1
#define AB_DEVICE_ANALOG 5
#define AB_JOYPAD_MASK 256
/* libretro joypad button ids (the `id` argument with AB_DEVICE_JOYPAD). */
#define AB_BTN_B 0
#define AB_BTN_Y 1
#define AB_BTN_SELECT 2
#define AB_BTN_START 3
#define AB_BTN_UP 4
#define AB_BTN_DOWN 5
#define AB_BTN_LEFT 6
#define AB_BTN_RIGHT 7
#define AB_BTN_A 8
#define AB_BTN_X 9
#define AB_BTN_L 10
#define AB_BTN_R 11
#define AB_BTN_L2 12
#define AB_BTN_R2 13
#define AB_BTN_L3 14
#define AB_BTN_R3 15
/* AB_DEVICE_ANALOG `index` values (libretro convention). Sticks use
 * index LEFT/RIGHT with id X/Y and return -32768..32767; BUTTON uses a
 * joypad id (AB_BTN_L2 for the left trigger) and returns 0..32767. */
#define AB_ANALOG_LEFT 0
#define AB_ANALOG_RIGHT 1
#define AB_ANALOG_BUTTON 2
#define AB_ANALOG_X 0
#define AB_ANALOG_Y 1

#if defined(__clang__)
#define AB_IMPORT(module, name) __attribute__((import_module(module), import_name(name)))
#define AB_EXPORT(name) __attribute__((export_name(name), visibility("default")))
#else
#define AB_IMPORT(module, name)
#define AB_EXPORT(name)
#endif

/* --- The pre_render hook (ABI 2, OPT-IN) ---------------------------------
 * A guest MAY export:
 *   AB_EXPORT("ab_pre_render") int32_t ab_pre_render(uint64_t frame);
 * The host calls it BEFORE the core runs the frame `frame`, every frame,
 * starting at frame 0 (post-reset, pre-execution RAM -- gate on the frame
 * number or a RAM signature if you need initialized state). Region writes
 * made here land before the game's own logic consumes them, and
 * input_override shapes what the core is about to be polled with. Region
 * READS here see post-previous-frame state (snapshot regions are NOT
 * re-refreshed between tick and pre_render -- they are the same instant).
 * MUST return 0; nonzero is reserved. If you export ab_pre_render, report
 * AB_ABI_VERSION 2 from ab_abi_version. Absent export = hook never called,
 * nothing else changes. */
AB_IMPORT("ab_host", "logical_width") extern int32_t ab_logical_width(void);
AB_IMPORT("ab_host", "logical_height") extern int32_t ab_logical_height(void);
AB_IMPORT("ab_host", "physical_width") extern int32_t ab_physical_width(void);
AB_IMPORT("ab_host", "physical_height") extern int32_t ab_physical_height(void);
AB_IMPORT("ab_host", "input_state") extern int32_t ab_input_state(int32_t, int32_t, int32_t, int32_t);
/* Replace what the CORE will see for this button/mask on the frame about to
 * run. Only honored inside ab_pre_render (see the hook note below); the
 * override is cleared before every pre_render, so a bezel re-asserts it each
 * frame. input_state keeps reporting the PHYSICAL pad -- the game sees the
 * override, the bezel sees the truth, so remap logic cannot feed back on its
 * own output. (port, device, index, id, value) mirrors input_state;
 * id AB_JOYPAD_MASK replaces the whole 16-bit joypad word. Returns 1 if the
 * host accepted it, 0 outside pre_render or when the host cannot override. */
AB_IMPORT("ab_host", "input_override") extern int32_t ab_input_override(int32_t, int32_t, int32_t, int32_t, int32_t);
AB_IMPORT("ab_host", "region_generation") extern int32_t ab_region_generation(void);
AB_IMPORT("ab_host", "region_count") extern int32_t ab_region_count(void);
AB_IMPORT("ab_host", "region_find") extern int32_t ab_region_find_raw(const char *, int32_t);
AB_IMPORT("ab_host", "region_find_id") extern int32_t ab_region_find_id(int32_t);
AB_IMPORT("ab_host", "region_size") extern int32_t ab_region_size(int32_t);
AB_IMPORT("ab_host", "region_flags") extern int32_t ab_region_flags(int32_t);
AB_IMPORT("ab_host", "region_offset") extern int32_t ab_region_offset(int32_t);
AB_IMPORT("ab_host", "region_read_u8") extern int32_t ab_region_read_u8(int32_t, int32_t);
/* Bulk copy a region span straight into guest memory: ONE crossing instead of
 * one per byte. Returns bytes copied. Hosts predating this import resolve it
 * to a stub that returns 0, so callers must fall back to region_read_u8 --
 * see ab_region_slurp in runtimes/common/ab_render.c for the canonical shape. */
AB_IMPORT("ab_host", "region_read") extern int32_t ab_region_read(int32_t, int32_t, void *, int32_t);
AB_IMPORT("ab_host", "region_write_u8") extern int32_t ab_region_write_u8(int32_t, int32_t, int32_t);
AB_IMPORT("ab_host", "config_bool") extern int32_t ab_config_bool_raw(const char *, int32_t);
AB_IMPORT("ab_host", "config_number") extern double ab_config_number_raw(const char *, int32_t);
AB_IMPORT("ab_host", "config_string_length") extern int32_t ab_config_string_length_raw(const char *, int32_t);
AB_IMPORT("ab_host", "config_string_read") extern int32_t ab_config_string_read_raw(const char *, int32_t, char *, int32_t);
AB_IMPORT("ab_host", "asset_size") extern int32_t ab_asset_size_raw(const char *, int32_t);
AB_IMPORT("ab_host", "asset_read") extern int32_t ab_asset_read_raw(const char *, int32_t, void *, int32_t);
AB_IMPORT("ab_host", "command_clear") extern void ab_clear(uint32_t rgba);
AB_IMPORT("ab_host", "command_draw_game") extern void ab_draw_game(double, double, double, double, int32_t);
AB_IMPORT("ab_host", "command_draw_game_fit") extern void ab_draw_game_fit(int32_t, double, double, int32_t);
AB_IMPORT("ab_host", "command_fill_rect") extern void ab_fill_rect(double, double, double, double, uint32_t);
AB_IMPORT("ab_host", "command_triangle") extern void ab_triangle(double, double, double, double, double, double, uint32_t);
AB_IMPORT("ab_host", "command_text") extern void ab_text_raw(const char *, int32_t, double, double, double, uint32_t);
AB_IMPORT("ab_host", "command_scissor") extern void ab_scissor(double, double, double, double);
AB_IMPORT("ab_host", "command_scissor_reset") extern void ab_scissor_reset(void);

/* --- Transforms ----------------------------------------------------------
 * A 2D affine stack. Applied to every command as it is submitted, so a
 * rotation means the same thing on the CPU and GPU backends. A rotated
 * rectangle is emitted as two triangles rather than silently losing the
 * rotation. Text and scissor rects are axis-aligned by definition: they
 * follow translate/scale but are not rotated. */
/* --- Picture effect ------------------------------------------------------
 * A GLSL ES 3.00 FRAGMENT shader run over the composed scene. Declare:
 *   in vec2 v_uv;  out vec4 out_color;
 * and you may sample `uniform sampler2D u_texture` (the scene) plus
 * `uniform vec2 u_resolution` and `uniform float u_time` (seconds).
 *
 * The filtered result is read back into the authoritative composition, so
 * screenshots, frame hashes and the livestream all see the same pixels -- an
 * effect is not display-only. Returns 0 if the shader failed to compile, in
 * which case the UNFILTERED picture is kept rather than ending the session. */
AB_IMPORT("ab_host", "effect_set") extern int32_t ab_effect_set_raw(const char *, int32_t);
AB_IMPORT("ab_host", "effect_clear") extern int32_t ab_effect_clear(void);
/* ab_strlen is defined with the other helpers below; declared here because
 * this wrapper appears first. (Strict C99 rejects the implicit declaration
 * this used to rely on -- caught building the Lua runtime under emcc.) */
static inline int32_t ab_strlen(const char *s);
static inline int32_t ab_effect_set(const char *s) { return ab_effect_set_raw(s, ab_strlen(s)); }

/* --- Time ----------------------------------------------------------------
 * ab_tick's `frame` is the EMULATOR's frame counter, which arrives in jumps:
 * a host may tick a bezel at 60fps in a window, or hundreds of frames at once
 * during a scripted step. Animate against these instead.
 *   ab_elapsed_ms  monotonic milliseconds since ab_init
 *   ab_delta_ms    milliseconds since the previous tick, clamped to 250 so a
 *                  long pause cannot teleport an animation forward */
AB_IMPORT("ab_host", "time_elapsed_ms") extern double ab_elapsed_ms(void);
AB_IMPORT("ab_host", "time_delta_ms") extern double ab_delta_ms(void);

AB_IMPORT("ab_host", "command_push_transform") extern int32_t ab_push_transform(void);
AB_IMPORT("ab_host", "command_pop_transform") extern int32_t ab_pop_transform(void);
AB_IMPORT("ab_host", "command_reset_transform") extern void ab_reset_transform(void);
AB_IMPORT("ab_host", "command_translate") extern void ab_translate(double, double);
AB_IMPORT("ab_host", "command_scale") extern void ab_scale(double, double);
AB_IMPORT("ab_host", "command_rotate") extern void ab_rotate(double);

/* Shear, as tangents: ab_skew(M_PI/6, 0) leans 30 degrees to the right.
 * A sheared rect is not a rect, so it becomes real geometry like a rotated
 * one does. */
AB_IMPORT("ab_host", "command_skew") extern void ab_skew(double x, double y);

/* Concatenate an arbitrary 2x3 affine: (x,y) -> (a*x + c*y + e, b*x + d*y + f).
 * Every other transform verb is a named case of this. */
AB_IMPORT("ab_host", "command_transform2d")
extern void ab_transform2d(double a, double b, double c, double d, double e, double f);

/* A textured quad with PERSPECTIVE-CORRECT sampling: four corners in any
 * convex arrangement, the texture mapped as if the quad were a plane in 3D.
 * This is the difference between a tilt that reads as a receding surface and
 * one that warps like a PS1 polygon. Corners are [tl, tr, br, bl]; UVs are
 * the unit square. Pass handle 0 for an untextured gradient. */
typedef struct { double x, y; } ab_point;
AB_IMPORT("ab_host", "command_quad")
extern int32_t ab_quad_raw(const ab_point *corners, int32_t handle, uint32_t rgba);
static inline int32_t ab_quad(const ab_point *corners, int32_t handle, uint32_t rgba) {
  return ab_quad_raw(corners, handle, rgba);
}

/* --- Offscreen surfaces --------------------------------------------------
 * A surface is a render target the guest allocates and REUSES across frames.
 * Draw into it, run a shader over it, then use its handle anywhere a texture
 * is accepted -- ab_draw_texture, ab_mesh, ab_quad.
 *
 * Why this exists: ab_effect_set runs over the FINISHED scene, which is the
 * wrong stage for a bezel that puts the game inside an object. Filtering
 * there filters the object too, and a warp in the shader fights whatever
 * perspective the game was already mapped through. Filter into a surface
 * instead and the shader runs flat, at the source's own scale, exactly as it
 * was written; the geometry then happens once, afterwards.
 *
 * A shader used here gets `u_texture`, `u_resolution` (the destination),
 * `u_source_size` (the source, in texels) and `u_time`. */
AB_IMPORT("ab_host", "surface_create") extern int32_t ab_surface_create(int32_t w, int32_t h);
AB_IMPORT("ab_host", "surface_target") extern int32_t ab_surface_target(int32_t handle);
AB_IMPORT("ab_host", "surface_end") extern int32_t ab_surface_end(void);
AB_IMPORT("ab_host", "surface_filter")
extern int32_t ab_surface_filter_raw(int32_t source, int32_t destination,
                                     const char *shader, int32_t length);
static inline int32_t ab_surface_filter(int32_t source, int32_t destination, const char *shader) {
  return ab_surface_filter_raw(source, destination, shader, ab_strlen(shader));
}

/* Run a multi-pass RetroArch `.glslp` preset from the package into a surface.
 *
 * surface_filter above takes ONE fragment shader, which covers most effects.
 * The serious CRT presets are not one shader: crt-royale is twelve passes with
 * six lookup textures, each pass rendering into its own buffer at its own
 * resolution and later passes sampling several earlier ones. That cannot be
 * flattened into a single shader at any size.
 *
 * `preset` names a `.glslp` inside the package; its relative `shaderN` paths
 * resolve against the preset's own directory, so a preset tree can be dropped
 * into the package as-is. The destination surface acts as the preset's
 * viewport, which is what lets the same preset serve a full-screen picture or
 * a small on-screen tube.
 *
 * Returns 0 if the preset cannot be run -- CPU compositor, a pass that fails
 * to compile, or lookup textures with no decoder wired up. It never renders a
 * partial chain: a preset either runs as written or does not run. */
AB_IMPORT("ab_host", "surface_preset")
extern int32_t ab_surface_preset_raw(int32_t source, int32_t destination,
                                     const char *preset, int32_t length);
static inline int32_t ab_surface_preset(int32_t source, int32_t destination, const char *preset) {
  return ab_surface_preset_raw(source, destination, preset, ab_strlen(preset));
}

/* Pass as a source/texture handle to mean THE LIVE GAME FRAME. */
#define AB_GAME_TEXTURE (-1)

/* --- Geometry batches ----------------------------------------------------
 * Triangles with per-vertex colour and optional UVs, submitted as ONE command
 * instead of N. That matters: the host caps a frame at 16384 commands, and a
 * gradient or polygon fan drawn one triangle at a time burns through it.
 * Pass handle 0 for untextured (vertex colour), or a texture handle to sample.
 * Every three vertices form a triangle. */
typedef struct {
  float x, y;      /* logical canvas coordinates */
  float u, v;      /* texture coordinates, 0..1 (ignored when handle == 0) */
  uint32_t rgba;   /* 0xRRGGBBAA, interpolated across the triangle */
  uint32_t _pad;
} ab_vertex;
AB_IMPORT("ab_host", "command_mesh") extern int32_t ab_mesh(const ab_vertex *, int32_t, int32_t);
AB_IMPORT("ab_host", "texture_create_rgba") extern int32_t ab_texture_create_rgba(const void *, int32_t, int32_t);
AB_IMPORT("ab_host", "texture_destroy") extern int32_t ab_texture_destroy(int32_t);
AB_IMPORT("ab_host", "texture_filter") extern int32_t ab_texture_filter(int32_t, int32_t);
AB_IMPORT("ab_host", "texture_palette") extern int32_t ab_texture_palette(int32_t, int32_t);
AB_IMPORT("ab_host", "texture_update") extern int32_t ab_texture_update(int32_t, int32_t, int32_t, int32_t, int32_t, const void *);
AB_IMPORT("ab_host", "command_draw_texture") extern int32_t ab_draw_texture(int32_t, double, double, double, double);
/* Draw a SUB-RECTANGLE of a texture: (sx,sy,sw,sh) in texture pixels. Lets a
 * guest keep one atlas and draw entries from it, instead of one texture per
 * entry -- the difference between a command per tile and a command per pixel. */
AB_IMPORT("ab_host", "command_draw_texture_rect") extern int32_t ab_draw_texture_rect(int32_t, double, double, double, double, int32_t, int32_t, int32_t, int32_t);
/* Read THIS frame's game picture. Needed to match the emulator's own colours:
 * converting a palette index through the guest's NTSC table gives visibly
 * different RGB, because cores disagree on that decode. Returns 0xRRGGBBAA. */
AB_IMPORT("ab_host", "game_width") extern int32_t ab_game_width(void);
AB_IMPORT("ab_host", "game_height") extern int32_t ab_game_height(void);
AB_IMPORT("ab_host", "game_pixel") extern uint32_t ab_game_pixel(int32_t, int32_t);
AB_IMPORT("ab_host", "log") extern void ab_log_raw(const char *, int32_t);

static inline int32_t ab_strlen(const char *s) {
  int32_t n = 0;
  while (s[n]) n++;
  return n;
}
static inline int32_t ab_region_find(const char *s) { return ab_region_find_raw(s, ab_strlen(s)); }
static inline int32_t ab_config_bool(const char *s) { return ab_config_bool_raw(s, ab_strlen(s)); }
static inline double ab_config_number(const char *s) { return ab_config_number_raw(s, ab_strlen(s)); }
static inline int32_t ab_config_string(const char *key, char *dst, int32_t capacity) {
  int32_t n;
  if (capacity <= 0) return 0;
  n = ab_config_string_read_raw(key, ab_strlen(key), dst, capacity - 1);
  if (n < 0) n = 0;
  dst[n] = 0;
  return n;
}
static inline int32_t ab_asset_size(const char *s) { return ab_asset_size_raw(s, ab_strlen(s)); }
static inline int32_t ab_asset_read(const char *s, void *dst, int32_t capacity) {
  return ab_asset_read_raw(s, ab_strlen(s), dst, capacity);
}
static inline void ab_log(const char *s) { ab_log_raw(s, ab_strlen(s)); }
static inline void ab_text(const char *s, double x, double y, double size, uint32_t color) {
  ab_text_raw(s, ab_strlen(s), x, y, size, color);
}
static inline uint16_t ab_region_read_u16_le(int32_t r, int32_t o) {
  return (uint16_t)(ab_region_read_u8(r, o) | (ab_region_read_u8(r, o + 1) << 8));
}
static inline uint16_t ab_region_read_u16_be(int32_t r, int32_t o) {
  return (uint16_t)((ab_region_read_u8(r, o) << 8) | ab_region_read_u8(r, o + 1));
}

#endif
