import * as LR from '../constants/libretro.js';

// W3C Standard Gamepad button index → libretro RETRO_DEVICE_ID_JOYPAD_*
//
// W3C standard mapping:
//   0=South(A), 1=East(B), 2=West(X), 3=North(Y),
//   4=L1, 5=R1, 6=L2, 7=R2,
//   8=Select, 9=Start, 10=L3, 11=R3,
//   12=DPad Up, 13=DPad Down, 14=DPad Left, 15=DPad Right, 16=Guide
//
// gamepad-node uses positional mapping: South=A, East=B, West=X, North=Y
// libretro SNES layout: B=South, A=East, Y=West, X=North

export const W3C_TO_LIBRETRO = new Int8Array(17);
W3C_TO_LIBRETRO[0]  = LR.JOYPAD_B;       // W3C South  → libretro B (south)
W3C_TO_LIBRETRO[1]  = LR.JOYPAD_A;       // W3C East   → libretro A (east)
W3C_TO_LIBRETRO[2]  = LR.JOYPAD_Y;       // W3C West   → libretro Y (west)
W3C_TO_LIBRETRO[3]  = LR.JOYPAD_X;       // W3C North  → libretro X (north)
W3C_TO_LIBRETRO[4]  = LR.JOYPAD_L;       // W3C L1     → libretro L
W3C_TO_LIBRETRO[5]  = LR.JOYPAD_R;       // W3C R1     → libretro R
W3C_TO_LIBRETRO[6]  = LR.JOYPAD_L2;      // W3C L2     → libretro L2
W3C_TO_LIBRETRO[7]  = LR.JOYPAD_R2;      // W3C R2     → libretro R2
W3C_TO_LIBRETRO[8]  = LR.JOYPAD_SELECT;  // W3C Select → libretro Select
W3C_TO_LIBRETRO[9]  = LR.JOYPAD_START;   // W3C Start  → libretro Start
W3C_TO_LIBRETRO[10] = LR.JOYPAD_L3;      // W3C L3     → libretro L3
W3C_TO_LIBRETRO[11] = LR.JOYPAD_R3;      // W3C R3     → libretro R3
W3C_TO_LIBRETRO[12] = LR.JOYPAD_UP;      // W3C DUp    → libretro Up
W3C_TO_LIBRETRO[13] = LR.JOYPAD_DOWN;    // W3C DDown  → libretro Down
W3C_TO_LIBRETRO[14] = LR.JOYPAD_LEFT;    // W3C DLeft  → libretro Left
W3C_TO_LIBRETRO[15] = LR.JOYPAD_RIGHT;   // W3C DRight → libretro Right
W3C_TO_LIBRETRO[16] = -1;                // W3C Guide  → unmapped

// Reverse map: libretro joypad ID → W3C button index
export const LIBRETRO_TO_W3C = new Int8Array(16);
for (let w3c = 0; w3c < 16; w3c++) {
  const lr = W3C_TO_LIBRETRO[w3c];
  if (lr >= 0 && lr < 16) {
    LIBRETRO_TO_W3C[lr] = w3c;
  }
}

// W3C analog axes: 0=leftX, 1=leftY, 2=rightX, 3=rightY
// Libretro analog: index=LEFT/RIGHT, id=X/Y
// Convert W3C axis float (-1..1) to libretro int16 (-32768..32767)
export function axisToLibretro(value) {
  return Math.round(Math.max(-1, Math.min(1, value)) * 32767);
}
