// Rewind ring: periodic serialized states, capped by total bytes so heavy
// cores (PSX-class multi-MB states) automatically keep a shorter history
// instead of eating unbounded memory.
export class RewindBuffer {
  constructor({ maxBytes = 64 * 1024 * 1024, maxEntries = 240 } = {}) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.entries = []; // { data: Buffer, frame: number }
    this.totalBytes = 0;
  }

  push(data, frame) {
    this.entries.push({ data, frame });
    this.totalBytes += data.length;
    while (
      this.entries.length > this.maxEntries ||
      (this.totalBytes > this.maxBytes && this.entries.length > 1)
    ) {
      this.totalBytes -= this.entries.shift().data.length;
    }
  }

  // Pop `steps` snapshots back and return the state to restore (the oldest of
  // the popped range). One step = one snapshot interval.
  pop(steps = 1) {
    if (!this.entries.length) return null;
    let entry = null;
    for (let i = 0; i < steps && this.entries.length; i++) {
      entry = this.entries.pop();
      this.totalBytes -= entry.data.length;
    }
    return entry;
  }

  get depth() {
    return this.entries.length;
  }

  clear() {
    this.entries = [];
    this.totalBytes = 0;
  }
}
