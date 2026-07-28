// SystemDetector maps a ROM path to {system, core}. It is the first thing the
// CLI does with a user's file, so a wrong answer here surfaces as "unsupported
// file" or — worse — as the wrong core being loaded for a valid ROM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSystem,
  getSupportedExtensions,
  getSystemName,
} from '../../src/core/SystemDetector.js';

test('maps common extensions to the right core', () => {
  for (const [file, system, core] of [
    ['game.nes', 'nes', 'fceumm'],
    ['game.wasc', 'wasmcart', 'wasmcart'],
    ['game.jsgame', 'jsgame', 'jsgame'],
    ['game.gtr', 'gametank', 'gametank'],
    ['disc.gdi', 'dreamcast', 'flycast'],
  ]) {
    const got = detectSystem(file);
    assert.ok(got, `${file} should be recognized`);
    assert.equal(got.system, system, `${file} system`);
    assert.equal(got.core, core, `${file} core`);
  }
});

test('.p8.png is a DOUBLE extension, not a PNG', () => {
  // path.extname() sees only `.png` here. A PICO-8 cart embedded in its label
  // image must still route to fake08 — miss this and the file reads as an
  // unsupported image.
  const got = detectSystem('/carts/celeste.p8.png');
  assert.ok(got, 'p8.png must be recognized');
  assert.equal(got.system, 'pico8');
  assert.equal(got.core, 'fake08');
  assert.equal(got.extension, '.p8.png', 'reports the full double extension');

  // ...and a plain .png is still nothing we can run.
  assert.equal(detectSystem('/pics/screenshot.png'), null);
});

test('extension matching is case-insensitive', () => {
  // ROM sets routinely ship uppercase names.
  const lower = detectSystem('game.nes');
  const upper = detectSystem('GAME.NES');
  assert.ok(upper, 'uppercase extension must resolve');
  assert.equal(upper.system, lower.system);
  assert.equal(upper.core, lower.core);
  assert.equal(detectSystem('/carts/CELESTE.P8.PNG')?.core, 'fake08');
});

test('an unknown extension returns null rather than guessing', () => {
  assert.equal(detectSystem('notes.txt'), null);
  assert.equal(detectSystem('noextension'), null);
});

test('every supported extension resolves and names its system', () => {
  const exts = getSupportedExtensions();
  assert.ok(exts.length > 10, 'expected a real extension table');
  for (const ext of exts) {
    const got = detectSystem(`rom${ext}`);
    assert.ok(got, `${ext} is advertised as supported but does not resolve`);
    assert.ok(got.core, `${ext} resolves without a core`);
    // systemName must be a human string, never the raw id fallback leaking
    // through as undefined.
    assert.equal(typeof got.systemName, 'string');
    assert.ok(got.systemName.length > 0, `${ext} has an empty system name`);
  }
});

test('getSystemName falls back to the id instead of undefined', () => {
  assert.equal(getSystemName('nes'), 'Nintendo Entertainment System');
  assert.equal(getSystemName('not-a-real-system'), 'not-a-real-system');
});
