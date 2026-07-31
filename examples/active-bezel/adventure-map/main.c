#include "active_bezel.h"

#define COVER_WIDTH 150
#define COVER_HEIGHT 209
#define COVER_BYTES (COVER_WIDTH * COVER_HEIGHT * 4)

static int32_t ram;
static int32_t cover_texture;
static uint8_t cover_rgba[COVER_BYTES];

AB_EXPORT("ab_abi_version")
int32_t ab_abi_version(void) { return AB_ABI_VERSION; }

AB_EXPORT("ab_init")
int32_t ab_init(uint32_t descriptor) {
  int32_t cover_size;
  (void)descriptor;
  ram = ab_region_find_id(2);
  cover_texture = -1;
  cover_size = ab_asset_size("assets/adventure-cover.rgba");
  if (cover_size == COVER_BYTES &&
      ab_asset_read("assets/adventure-cover.rgba", cover_rgba, COVER_BYTES) == COVER_BYTES) {
    cover_texture = ab_texture_create_rgba(cover_rgba, COVER_WIDTH, COVER_HEIGHT);
  }
  return ram < 0 ? 1 : 0;
}

AB_EXPORT("ab_tick")
void ab_tick(uint64_t frame) {
  int32_t room;
  int32_t x;
  int32_t y;
  (void)frame;
  room = ab_region_read_u8(ram, 0x0a);
  x = ab_region_read_u8(ram, 0x0b);
  y = ab_region_read_u8(ram, 0x0c);
  ab_clear(0x10100fffu);
  ab_draw_game(600, 0, 720, 1080, AB_SAMPLE_NEAREST);
  if (ab_config_bool("show_map")) {
    int32_t i;
    for (i = 0; i < 30; i++) {
      double px = 40 + (i % 5) * 104;
      double py = 180 + (i / 5) * 104;
      ab_fill_rect(px, py, 92, 92, i == room ? 0xe5c07bffu : 0x29334affu);
    }
    ab_fill_rect(40 + (room % 5) * 104 + x * 0.35,
                 180 + (room / 5) * 104 + y * 0.35, 16, 16, 0xffffffffu);
  }
  ab_text("ADVENTURE", 80, 70, 42, 0xe5c07bffu);
  ab_text("ORIGINAL ART", 1418, 70, 32, 0xe5c07bffu);
  if (cover_texture >= 0) {
    ab_fill_rect(1372, 138, 496, 724, 0xe5c07bffu);
    ab_draw_texture(cover_texture, 1384, 150, 472, 700);
  }
}
