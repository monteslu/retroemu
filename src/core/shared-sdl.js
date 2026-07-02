// One SDL instance to rule them all.
//
// retroemu, gamepad-node, webaudio-node, wasmcart, and rungame each do
// `import sdl from '@kmamal/sdl'`. When npm dedupes to a single copy (usual on Linux)
// they all share ONE native SDL instance with ONE event queue — controllers + audio work.
// But a fresh `npx` install (esp. on macOS, where the native-dep tree resolves differently)
// can NEST a second @kmamal/sdl copy: then retroemu pumps events on instance A while
// gamepad-node reads instance B → button presses never appear (dead input), and audio
// comes from a different context.
//
// The fix: retroemu imports SDL here, ONCE, and forces every consumer that supports it
// onto THIS instance via their setSdl() hooks — regardless of how many copies npm made.
// Import this module early (before InputManager / AudioBridge / any jsgame session).

import sdl from '@kmamal/sdl';
import { setSdl as setGamepadSdl } from 'gamepad-node';
import { setSdl as setAudioSdl } from 'webaudio-node';

export const SDL = sdl;

let _shared = false;

/** Force gamepad-node + webaudio-node onto retroemu's single SDL instance. Idempotent. */
export function shareSdl() {
  if (_shared) return sdl;
  try { setGamepadSdl(sdl); } catch { /* older gamepad-node without setSdl */ }
  try { setAudioSdl(sdl); } catch { /* older webaudio-node without setSdl */ }
  _shared = true;
  return sdl;
}
