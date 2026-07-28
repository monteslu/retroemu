// Controller button mapping. gamepad-node reports W3C POSITIONAL buttons
// (South/East/West/North) while libretro uses the SNES lettering, where B is
// the SOUTH face button and A is the EAST one. That crossover is silent when
// wrong — the game runs, the buttons are just swapped — so it is pinned here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { W3C_TO_LIBRETRO, LIBRETRO_TO_W3C, axisToLibretro } from '../../src/input/InputMap.js';
import * as LR from '../../src/constants/libretro.js';

test('face buttons cross over positionally, not by letter', () => {
  // The bug this guards: mapping W3C "A" (index 0) to libretro A. Index 0 is
  // the SOUTH button, which libretro calls B.
  assert.equal(W3C_TO_LIBRETRO[0], LR.JOYPAD_B, 'W3C South -> libretro B');
  assert.equal(W3C_TO_LIBRETRO[1], LR.JOYPAD_A, 'W3C East  -> libretro A');
  assert.equal(W3C_TO_LIBRETRO[2], LR.JOYPAD_Y, 'W3C West  -> libretro Y');
  assert.equal(W3C_TO_LIBRETRO[3], LR.JOYPAD_X, 'W3C North -> libretro X');
});

test('shoulders, d-pad and menu buttons map straight through', () => {
  assert.equal(W3C_TO_LIBRETRO[4], LR.JOYPAD_L);
  assert.equal(W3C_TO_LIBRETRO[5], LR.JOYPAD_R);
  assert.equal(W3C_TO_LIBRETRO[6], LR.JOYPAD_L2);
  assert.equal(W3C_TO_LIBRETRO[7], LR.JOYPAD_R2);
  assert.equal(W3C_TO_LIBRETRO[8], LR.JOYPAD_SELECT);
  assert.equal(W3C_TO_LIBRETRO[9], LR.JOYPAD_START);
  assert.equal(W3C_TO_LIBRETRO[12], LR.JOYPAD_UP);
  assert.equal(W3C_TO_LIBRETRO[13], LR.JOYPAD_DOWN);
  assert.equal(W3C_TO_LIBRETRO[14], LR.JOYPAD_LEFT);
  assert.equal(W3C_TO_LIBRETRO[15], LR.JOYPAD_RIGHT);
});

test('Guide is explicitly unmapped (-1), not silently button 0', () => {
  // A zero here would make the Guide button press libretro B on every tap.
  assert.equal(W3C_TO_LIBRETRO[16], -1);
});

test('the reverse map round-trips every mapped button', () => {
  for (let w3c = 0; w3c < 16; w3c++) {
    const lr = W3C_TO_LIBRETRO[w3c];
    if (lr < 0) continue;
    assert.equal(LIBRETRO_TO_W3C[lr], w3c,
      `libretro ${lr} should map back to W3C ${w3c}`);
  }
});

test('axis conversion covers the full int16 range and clamps', () => {
  assert.equal(axisToLibretro(0), 0, 'centre is exactly 0');
  assert.equal(axisToLibretro(1), 32767, 'full right/down');
  assert.equal(axisToLibretro(-1), -32767, 'full left/up');
  // Out-of-range input must clamp, never wrap into the opposite direction.
  assert.equal(axisToLibretro(5), 32767);
  assert.equal(axisToLibretro(-5), -32767);
  // Anything a stick actually produces stays inside int16.
  for (const v of [-1, -0.73, -0.01, 0, 0.01, 0.5, 0.999, 1]) {
    const out = axisToLibretro(v);
    assert.ok(Number.isInteger(out), `${v} must convert to an integer`);
    assert.ok(out >= -32768 && out <= 32767, `${v} -> ${out} escaped int16`);
  }
});
