import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayAspectFor, parseAspectMode } from '../../src/video/aspect.js';

test('tv mode: 4:3 consoles present at 4:3 regardless of the framebuffer', () => {
  assert.equal(displayAspectFor('tv', 'nes', 256, 240, 0), 4 / 3);
  assert.equal(displayAspectFor('tv', 'snes', 256, 224, 0), 4 / 3);
  assert.equal(displayAspectFor('tv', 'genesis', 320, 224, 0), 4 / 3);
  assert.equal(displayAspectFor('tv', 'sms', 256, 192, 0), 4 / 3);
  // A core reporting the bare fb ratio must not leak through for a TV system
  assert.equal(displayAspectFor('tv', 'nes', 256, 240, 256 / 240), 4 / 3);
});

test('tv mode: handheld LCDs are square-pixel — native fb shape wins', () => {
  assert.equal(displayAspectFor('tv', 'gb', 160, 144, 0), 160 / 144);
  assert.equal(displayAspectFor('tv', 'gbc', 160, 144, 4 / 3), 160 / 144);
  assert.equal(displayAspectFor('tv', 'gba', 240, 160, 0), 240 / 160);
  assert.equal(displayAspectFor('tv', 'lynx', 160, 102, 0), 160 / 102);
});

test('native mode: always the framebuffer ratio, even for TV consoles', () => {
  assert.equal(displayAspectFor('native', 'nes', 256, 240, 4 / 3), 256 / 240);
  assert.equal(displayAspectFor('native', 'gb', 160, 144, 0), 160 / 144);
});

test('core mode: reported ratio when real, fb ratio when the core says 0', () => {
  assert.equal(displayAspectFor('core', 'nes', 256, 240, 4 / 3), 4 / 3);
  assert.equal(displayAspectFor('core', 'nes', 256, 240, 0), 256 / 240);
});

test('degenerate inputs never produce a 0 or NaN ratio', () => {
  for (const mode of ['tv', 'native', 'core']) {
    const r = displayAspectFor(mode, null, 0, 0, 0);
    assert.ok(Number.isFinite(r) && r > 0, `${mode} gave ${r}`);
  }
  const nan = displayAspectFor('tv', 'unknown-system', 320, 240, NaN);
  assert.ok(Number.isFinite(nan) && nan > 0);
});

test('parseAspectMode: tv/native/core, fb as a native alias, junk rejected', () => {
  assert.equal(parseAspectMode('tv'), 'tv');
  assert.equal(parseAspectMode('NATIVE'), 'native');
  assert.equal(parseAspectMode('fb'), 'native');
  assert.equal(parseAspectMode('core'), 'core');
  assert.equal(parseAspectMode('widescreen'), null);
  assert.equal(parseAspectMode(''), null);
});
