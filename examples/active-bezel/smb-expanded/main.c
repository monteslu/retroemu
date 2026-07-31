#include "active_bezel.h"

static int32_t ram;

AB_EXPORT("ab_abi_version")
int32_t ab_abi_version(void) { return AB_ABI_VERSION; }
AB_EXPORT("ab_init")
int32_t ab_init(uint32_t descriptor) {
  (void)descriptor;
  ram = ab_region_find_id(2);
  return ram < 0 ? 1 : 0;
}
AB_EXPORT("ab_tick")
void ab_tick(uint64_t frame) {
  int32_t lives;
  char layout[16];
  (void)frame;
  lives = ab_region_read_u8(ram, 0x075a);
  ab_clear(0x5c94fcffu);
  ab_config_string("layout", layout, 15);
  if (layout[0] == 'a') ab_draw_game(0, 0, 1440, 1080, AB_SAMPLE_NEAREST);
  else ab_draw_game(240, 0, 1440, 1080, AB_SAMPLE_NEAREST);
  ab_fill_rect(1440, 0, 480, 1080, 0x182030ffu);
  ab_text("WORLD AHEAD", 1510, 80, 30, 0xffffffffu);
  ab_text("LIVES", 1510, 820, 24, 0xffffffffu);
  ab_fill_rect(1510, 880, lives * 22, 34, 0xf8d858ffu);
}
