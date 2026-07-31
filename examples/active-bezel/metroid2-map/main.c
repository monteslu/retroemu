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
  int32_t energy;
  int32_t missiles;
  (void)frame;
  energy = ab_region_read_u8(ram, 0x1051);
  missiles = ab_region_read_u8(ram, 0x1054);
  ab_clear(0x08120fffu);
  ab_draw_game(360, 0, 1200, 1080, AB_SAMPLE_NEAREST);
  ab_text("SR388", 65, 65, 46, 0xa8d878ffu);
  ab_text("MISSION", 65, 135, 28, 0xffffffffu);
  ab_fill_rect(65, 220, 220, energy * 3, 0xa8d878ffu);
  ab_text("ENERGY", 65, 560, 24, 0xffffffffu);
  ab_fill_rect(1635, 220, missiles * 2, 42, 0xe05858ffu);
  ab_text("MISSILES", 1635, 290, 24, 0xffffffffu);
}
