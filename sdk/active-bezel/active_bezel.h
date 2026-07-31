#ifndef ACTIVE_BEZEL_H
#define ACTIVE_BEZEL_H

#include <stdint.h>

#define AB_ABI_VERSION 1
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

#if defined(__clang__)
#define AB_IMPORT(module, name) __attribute__((import_module(module), import_name(name)))
#define AB_EXPORT(name) __attribute__((export_name(name), visibility("default")))
#else
#define AB_IMPORT(module, name)
#define AB_EXPORT(name)
#endif

AB_IMPORT("ab_host", "logical_width") extern int32_t ab_logical_width(void);
AB_IMPORT("ab_host", "logical_height") extern int32_t ab_logical_height(void);
AB_IMPORT("ab_host", "physical_width") extern int32_t ab_physical_width(void);
AB_IMPORT("ab_host", "physical_height") extern int32_t ab_physical_height(void);
AB_IMPORT("ab_host", "input_state") extern int32_t ab_input_state(int32_t, int32_t, int32_t, int32_t);
AB_IMPORT("ab_host", "region_generation") extern int32_t ab_region_generation(void);
AB_IMPORT("ab_host", "region_count") extern int32_t ab_region_count(void);
AB_IMPORT("ab_host", "region_find") extern int32_t ab_region_find_raw(const char *, int32_t);
AB_IMPORT("ab_host", "region_find_id") extern int32_t ab_region_find_id(int32_t);
AB_IMPORT("ab_host", "region_size") extern int32_t ab_region_size(int32_t);
AB_IMPORT("ab_host", "region_flags") extern int32_t ab_region_flags(int32_t);
AB_IMPORT("ab_host", "region_offset") extern int32_t ab_region_offset(int32_t);
AB_IMPORT("ab_host", "region_read_u8") extern int32_t ab_region_read_u8(int32_t, int32_t);
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
AB_IMPORT("ab_host", "texture_create_rgba") extern int32_t ab_texture_create_rgba(const void *, int32_t, int32_t);
AB_IMPORT("ab_host", "texture_destroy") extern int32_t ab_texture_destroy(int32_t);
AB_IMPORT("ab_host", "command_draw_texture") extern int32_t ab_draw_texture(int32_t, double, double, double, double);
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
