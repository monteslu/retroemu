#include "active_bezel.h"

AB_EXPORT("ab_abi_version")
int32_t ab_abi_version(void) { return AB_ABI_VERSION; }

AB_EXPORT("ab_init")
int32_t ab_init(uint32_t descriptor) {
  (void)descriptor;
  ab_log("diagnostic bezel initialized");
  return 0;
}

AB_EXPORT("ab_tick")
void ab_tick(uint64_t frame) {
  (void)frame;
  ab_clear(0x101520ffu);
  if (ab_config_bool("game_left")) {
    ab_draw_game(80, 90, 1280, 900, AB_SAMPLE_NEAREST);
  } else {
    ab_draw_game(320, 0, 1280, 1080, AB_SAMPLE_NEAREST);
  }
}

AB_EXPORT("ab_event")
void ab_event(uint32_t type, uint32_t data) { (void)type; (void)data; }

AB_EXPORT("ab_shutdown")
void ab_shutdown(void) {}
