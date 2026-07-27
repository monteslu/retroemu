// The achievement EVALUATOR — the half retroachievements.js could not do.
//
// retroachievements.js talks to RA's web API: log in, identify a game, list
// its achievements and whether you have already earned them. It is read-only
// by construction. Actually unlocking one while you play means evaluating
// each achievement's condition string against console memory every frame,
// which is what rcheevos exists for.
//
// rcheevos is C. romdeck builds it to WASM (scripts/build-rcheevos.sh) rather
// than loading a native addon, because one .wasm runs everywhere romdeck does
// with no build matrix and no compiler on the user's machine. The published
// `rcheevos` npm package cannot be used for this: it is hash-only.
//
// SCOPE: rc_runtime, the pure evaluator. Not rc_client, which would bring its
// own HTTP stack, login and scheduling — all of which already exist in
// retroachievements.js.
//
// This module owns the WASM boundary and nothing else. It does not know what
// a session is, does not fetch anything, and does not decide when to award:
// callers give it achievement definitions and a way to read memory, and it
// tells them what triggered.
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_JS = path.join(__dirname, 'wasm', 'rcheevos.js');

/** rc_runtime event types we care about (rc_runtime.h). */
const EVENT_ACHIEVEMENT_TRIGGERED = 3;
const EVENT_ACHIEVEMENT_PRIMED = 4;
const EVENT_ACHIEVEMENT_UNPRIMED = 11;
const EVENT_ACHIEVEMENT_PROGRESS_UPDATED = 12;

/** rc_runtime_t is opaque; upstream's struct is comfortably under this. */
const RUNTIME_SIZE = 4096;

let modulePromise = null;

/** Has the evaluator been built? It is an optional artifact, like the decoder. */
export function evaluatorAvailable() {
  return existsSync(WASM_JS) && existsSync(path.join(__dirname, 'wasm', 'rcheevos.wasm'));
}

async function loadModule() {
  if (!modulePromise) {
    modulePromise = import(WASM_JS).then((m) => (m.default ?? m)());
  }
  return modulePromise;
}

/**
 * A live evaluator for one game's achievement set.
 *
 * Usage is deliberately small:
 *
 *   const ev = await AchievementRuntime.create();
 *   ev.activate([{ id, memaddr }, …]);
 *   ev.frame(peek);        // once per emulated frame
 *   ev.dispose();
 *
 * `peek(address, numBytes)` returns an unsigned integer. It is called MANY
 * times per frame — once per distinct memory reference in the active set — so
 * it must read from a buffer already in hand, never do IPC. See
 * ControlChannel's cheevos wiring, which snapshots system RAM once per frame
 * and serves peeks out of that snapshot.
 */
export class AchievementRuntime {
  constructor(M) {
    this.M = M;
    this.ptr = M._malloc(RUNTIME_SIZE);
    new Uint8Array(M.HEAPU8.buffer, this.ptr, RUNTIME_SIZE).fill(0);
    M._rc_runtime_init(this.ptr);

    this.active = new Map();   // id → { id, memaddr, title }
    this.triggered = new Set(); // ids that fired this session
    this.primed = new Set();    // ids "close" — for a UI hint
    this.disposed = false;

    // Two C function pointers, minted once and reused: rc_runtime_do_frame
    // takes them by pointer, and re-adding per frame would leak table slots.
    this._events = [];
    this._onEvent = M.addFunction((evPtr) => {
      this._events.push({
        id: M.getValue(evPtr, 'i32'),
        value: M.getValue(evPtr + 4, 'i32'),
        type: M.HEAPU8[evPtr + 8],
      });
    }, 'vi');
    this._peekImpl = () => 0;
    this._peek = M.addFunction((addr, num) => this._peekImpl(addr, num) >>> 0, 'iiii');
  }

  static async create() {
    if (!evaluatorAvailable()) {
      throw new Error('achievement evaluator not built — run scripts/build-rcheevos.sh');
    }
    return new AchievementRuntime(await loadModule());
  }

  /** rcheevos' own version, so a bug report can name the evaluator. */
  version() {
    return this.M.UTF8ToString(this.M._rc_version_string());
  }

  /**
   * Compile and arm a set of achievements.
   *
   * Returns the ones that FAILED to compile rather than throwing: a single
   * malformed definition upstream must not cost the player every other
   * achievement in the game.
   *
   * @param {Array<{id:number, memaddr:string, title?:string}>} list
   */
  activate(list) {
    const rejected = [];
    for (const a of list) {
      if (!a?.memaddr || !Number.isFinite(a.id)) { rejected.push({ ...a, error: 'no memaddr' }); continue; }
      if (this.active.has(a.id)) continue;
      const bytes = this.M.lengthBytesUTF8(a.memaddr) + 1;
      const p = this.M._malloc(bytes);
      this.M.stringToUTF8(a.memaddr, p, bytes);
      const rc = this.M._rc_runtime_activate_achievement(this.ptr, a.id, p, 0, 0);
      this.M._free(p);
      if (rc === 0) this.active.set(a.id, { id: a.id, memaddr: a.memaddr, title: a.title ?? null });
      else rejected.push({ ...a, error: `rc_runtime error ${rc}` });
    }
    return { activated: this.active.size, rejected };
  }

  /**
   * Evaluate one frame.
   *
   * @param {(address:number, numBytes:number) => number} peek
   * @returns {Array<{id:number, title:string|null}>} achievements that just unlocked
   */
  frame(peek) {
    if (this.disposed) return [];
    this._peekImpl = peek;
    this._events.length = 0;
    this.M._rc_runtime_do_frame(this.ptr, this._onEvent, this._peek, 0, 0);

    const unlocked = [];
    for (const ev of this._events) {
      switch (ev.type) {
        case EVENT_ACHIEVEMENT_TRIGGERED:
          // Deduped: rc_runtime deactivates a triggered achievement, but a
          // caller that re-activates (new game, reset) must not double-award.
          if (!this.triggered.has(ev.id)) {
            this.triggered.add(ev.id);
            this.primed.delete(ev.id);
            unlocked.push({ id: ev.id, title: this.active.get(ev.id)?.title ?? null });
          }
          break;
        case EVENT_ACHIEVEMENT_PRIMED: this.primed.add(ev.id); break;
        case EVENT_ACHIEVEMENT_UNPRIMED: this.primed.delete(ev.id); break;
        case EVENT_ACHIEVEMENT_PROGRESS_UPDATED: break; // for a progress UI later
        default: break;
      }
    }
    return unlocked;
  }

  /** Loading a save state means the old evaluation state is meaningless. */
  reset() {
    if (!this.disposed) this.M._rc_runtime_reset(this.ptr);
    this.primed.clear();
  }

  status() {
    return {
      version: this.disposed ? null : this.version(),
      active: this.active.size,
      triggered: this.triggered.size,
      primed: [...this.primed],
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.M._rc_runtime_destroy(this.ptr);
    this.M._free(this.ptr);
    // Table slots are a finite resource; a session per game would exhaust
    // them over a long sitting if these were never given back.
    this.M.removeFunction(this._onEvent);
    this.M.removeFunction(this._peek);
  }
}
