// Tiny 5x7 bitmap font for the in-game overlay. Glyphs are authored as
// readable X/. rows and compiled to row-bitmasks at load — slower to type,
// impossible to typo silently.
const GLYPHS = {
  A: ['.XXX.', 'X...X', 'X...X', 'XXXXX', 'X...X', 'X...X', 'X...X'],
  B: ['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X...X', 'X...X', 'XXXX.'],
  C: ['.XXX.', 'X...X', 'X....', 'X....', 'X....', 'X...X', '.XXX.'],
  D: ['XXXX.', 'X...X', 'X...X', 'X...X', 'X...X', 'X...X', 'XXXX.'],
  E: ['XXXXX', 'X....', 'X....', 'XXXX.', 'X....', 'X....', 'XXXXX'],
  F: ['XXXXX', 'X....', 'X....', 'XXXX.', 'X....', 'X....', 'X....'],
  G: ['.XXX.', 'X...X', 'X....', 'X.XXX', 'X...X', 'X...X', '.XXX.'],
  H: ['X...X', 'X...X', 'X...X', 'XXXXX', 'X...X', 'X...X', 'X...X'],
  I: ['XXXXX', '..X..', '..X..', '..X..', '..X..', '..X..', 'XXXXX'],
  J: ['..XXX', '...X.', '...X.', '...X.', '...X.', 'X..X.', '.XX..'],
  K: ['X...X', 'X..X.', 'X.X..', 'XX...', 'X.X..', 'X..X.', 'X...X'],
  L: ['X....', 'X....', 'X....', 'X....', 'X....', 'X....', 'XXXXX'],
  M: ['X...X', 'XX.XX', 'X.X.X', 'X.X.X', 'X...X', 'X...X', 'X...X'],
  N: ['X...X', 'XX..X', 'X.X.X', 'X..XX', 'X...X', 'X...X', 'X...X'],
  O: ['.XXX.', 'X...X', 'X...X', 'X...X', 'X...X', 'X...X', '.XXX.'],
  P: ['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X....', 'X....', 'X....'],
  Q: ['.XXX.', 'X...X', 'X...X', 'X...X', 'X.X.X', 'X..X.', '.XX.X'],
  R: ['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X.X..', 'X..X.', 'X...X'],
  S: ['.XXXX', 'X....', 'X....', '.XXX.', '....X', '....X', 'XXXX.'],
  T: ['XXXXX', '..X..', '..X..', '..X..', '..X..', '..X..', '..X..'],
  U: ['X...X', 'X...X', 'X...X', 'X...X', 'X...X', 'X...X', '.XXX.'],
  V: ['X...X', 'X...X', 'X...X', 'X...X', 'X...X', '.X.X.', '..X..'],
  W: ['X...X', 'X...X', 'X...X', 'X.X.X', 'X.X.X', 'XX.XX', 'X...X'],
  X: ['X...X', 'X...X', '.X.X.', '..X..', '.X.X.', 'X...X', 'X...X'],
  Y: ['X...X', 'X...X', '.X.X.', '..X..', '..X..', '..X..', '..X..'],
  Z: ['XXXXX', '....X', '...X.', '..X..', '.X...', 'X....', 'XXXXX'],
  0: ['.XXX.', 'X...X', 'X..XX', 'X.X.X', 'XX..X', 'X...X', '.XXX.'],
  1: ['..X..', '.XX..', '..X..', '..X..', '..X..', '..X..', 'XXXXX'],
  2: ['.XXX.', 'X...X', '....X', '...X.', '..X..', '.X...', 'XXXXX'],
  3: ['.XXX.', 'X...X', '....X', '..XX.', '....X', 'X...X', '.XXX.'],
  4: ['...X.', '..XX.', '.X.X.', 'X..X.', 'XXXXX', '...X.', '...X.'],
  5: ['XXXXX', 'X....', 'XXXX.', '....X', '....X', 'X...X', '.XXX.'],
  6: ['.XXX.', 'X....', 'XXXX.', 'X...X', 'X...X', 'X...X', '.XXX.'],
  7: ['XXXXX', '....X', '...X.', '..X..', '..X..', '..X..', '..X..'],
  8: ['.XXX.', 'X...X', 'X...X', '.XXX.', 'X...X', 'X...X', '.XXX.'],
  9: ['.XXX.', 'X...X', 'X...X', '.XXXX', '....X', '....X', '.XXX.'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  '-': ['.....', '.....', '.....', 'XXXXX', '.....', '.....', '.....'],
  ':': ['.....', '..X..', '.....', '.....', '.....', '..X..', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.XX..', '.XX..'],
  '>': ['X....', '.X...', '..X..', '...X.', '..X..', '.X...', 'X....'],
  '/': ['....X', '...X.', '...X.', '..X..', '.X...', '.X...', 'X....'],
  '+': ['.....', '..X..', '..X..', 'XXXXX', '..X..', '..X..', '.....'],
};

// Compile to row bitmasks: rows[7], bit 4 = leftmost column.
const COMPILED = {};
for (const [ch, rows] of Object.entries(GLYPHS)) {
  COMPILED[ch] = rows.map((r) => {
    let bits = 0;
    for (let i = 0; i < 5; i++) if (r[i] === 'X') bits |= 1 << (4 - i);
    return bits;
  });
}

export const GLYPH_W = 5;
export const GLYPH_H = 7;

/**
 * Draw text into an RGBA buffer.
 * @param {Uint8Array|Buffer} rgba
 * @param {number} bufW buffer width in pixels
 * @param {string} text (uppercased; unknown chars render as space)
 * @param {number} x top-left
 * @param {number} y top-left
 * @param {[number,number,number]} color
 * @param {number} scale integer pixel scale
 */
export function drawText(rgba, bufW, text, x, y, color, scale = 1) {
  const [r, g, b] = color;
  const upper = text.toUpperCase();
  const bufH = rgba.length / 4 / bufW;
  for (let ci = 0; ci < upper.length; ci++) {
    const glyph = COMPILED[upper[ci]] ?? COMPILED[' '];
    const gx = x + ci * (GLYPH_W + 1) * scale;
    for (let row = 0; row < GLYPH_H; row++) {
      const bits = glyph[row];
      if (!bits) continue;
      for (let col = 0; col < GLYPH_W; col++) {
        if (!(bits & (1 << (4 - col)))) continue;
        for (let sy = 0; sy < scale; sy++) {
          const py = y + row * scale + sy;
          if (py < 0 || py >= bufH) continue;
          for (let sx = 0; sx < scale; sx++) {
            const px = gx + col * scale + sx;
            if (px < 0 || px >= bufW) continue;
            const o = (py * bufW + px) * 4;
            rgba[o] = r;
            rgba[o + 1] = g;
            rgba[o + 2] = b;
            rgba[o + 3] = 255;
          }
        }
      }
    }
  }
}

export function textWidth(text, scale = 1) {
  return text.length * (GLYPH_W + 1) * scale;
}
