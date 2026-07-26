// Remote play — "a very long couch."
//
// Implements retroterm's network.md design: P1 hosts, P2 joins with a share
// code, hsync does ~3KB of signaling and then gets out of the way while
// video/audio/input run P2P over a WebRTC data channel. The emulator has no
// idea it's networked — it just sees a second controller.
//
// Share codes: the code IS the hsync hostname, formatted XXXX-XXXX so it's
// easy to read aloud. NOTE: hsync currently generates these from its own
// alphabet, which is not yet the doc's base24 set (codes can contain B, 8,
// etc.), so ambiguous characters are still possible — making hsync emit
// base24 is the server-side task network.md already lists.
//
// Video: instead of H.264, send the changed rows of the framebuffer,
// deflated. A static screen costs almost nothing; a scrolling one costs a
// few KB. Keyframes every 2s so a late joiner syncs quickly.
import { deflateSync, inflateSync } from 'node:zlib';
import {
  REMOTE_RATE, downmix, upmix, encodeChunk, decodeChunk, AudioPacketizer,
} from './audio.js';

const KEYFRAME_EVERY = 40; // frames between full sends
const DEFAULT_FPS = 20;
// WebRTC data channels cap individual message size (libdatachannel defaults to
// 16 KB and simply drops the channel if you exceed it), so every frame is split
// into small chunks and reassembled by the guest.
const CHUNK_CHARS = 8000;

export function formatCode(hostName) {
  const raw = String(hostName ?? '').replace(/^https?:\/\//, '').split('.')[0].toUpperCase();
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

/**
 * Share code → the peer host string hsync wants.
 * hsync interpolates hostName straight into a fetch URL, so it must carry a
 * scheme or the peer RPC throws "Invalid URL".
 */
export function parseCode(code, domain = 'hsync.tech') {
  const raw = String(code ?? '').trim().replace(/-/g, '').toLowerCase();
  if (!raw) throw new Error('empty share code');
  if (/^https?:\/\//.test(raw)) return raw;
  const host = raw.includes('.') ? raw : `${raw}.${domain}`;
  return `https://${host}`;
}

/** Pack a W3C gamepad into the doc's 7-byte wire format. */
export function packPad(pad) {
  const buf = new Uint8Array(7);
  const btn = (i) => (pad?.buttons?.[i]?.pressed ? 1 : 0);
  for (let i = 0; i < 8; i++) buf[0] |= btn(i) << i;
  for (let i = 8; i < 16; i++) buf[1] |= btn(i) << (i - 8);
  buf[2] = btn(16);
  const ax = (i) => Math.max(-128, Math.min(127, Math.round((pad?.axes?.[i] ?? 0) * 127)));
  buf[3] = ax(0) & 0xff;
  buf[4] = ax(1) & 0xff;
  buf[5] = ax(2) & 0xff;
  buf[6] = ax(3) & 0xff;
  return buf;
}

/** Unpack the 7-byte format back into a gamepad-shaped object. */
export function unpackPad(bytes) {
  const b = Uint8Array.from(bytes);
  const buttons = [];
  for (let i = 0; i < 8; i++) buttons.push({ pressed: !!(b[0] & (1 << i)), value: (b[0] >> i) & 1 });
  for (let i = 8; i < 16; i++) buttons.push({ pressed: !!(b[1] & (1 << (i - 8))), value: (b[1] >> (i - 8)) & 1 });
  buttons.push({ pressed: !!(b[2] & 1), value: b[2] & 1 });
  const sign = (v) => (v > 127 ? v - 256 : v) / 127;
  return { buttons, axes: [sign(b[3]), sign(b[4]), sign(b[5]), sign(b[6])], connected: true, remote: true };
}

// ── host ─────────────────────────────────────────────────────────────
export class RemoteHost {
  constructor({
    videoOutput, inputManager, audioBridge = null, guestPort = 1,
    fps = DEFAULT_FPS, audio = true, log = () => {},
  }) {
    this.videoOutput = videoOutput;
    this.inputManager = inputManager;
    this.audioBridge = audioBridge;
    this.audioEnabled = audio;
    this.audioBytes = 0;
    this._prevOnPcm = null;
    this._packetizer = null;
    this.guestPort = guestPort;
    this.minInterval = 1000 / fps;
    this.log = log;
    this.con = null;
    this.peers = new Set();
    this.code = null;
    this.last = null; // previous frame for delta
    this.frameNo = 0;
    this.lastSent = 0;
    this.bytesSent = 0;
    this._prevOnFrame = null;
  }

  async start() {
    const { dynamicConnect } = await import('hsync');
    this.con = await dynamicConnect();
    this.code = formatCode(this.con.myHostName);

    // Guests appear as peers; hsync creates them on the inbound RTC request.
    this.con.peers?.on?.('peerCreated', (peer) => this._attach(peer));

    // Tap the video path (chained so the local window keeps working).
    this._prevOnFrame = this.videoOutput.onFrameCallback;
    this.videoOutput.onFrameCallback = (rgba, w, h) => {
      this._onFrame(rgba, w, h);
      if (this._prevOnFrame) this._prevOnFrame(rgba, w, h);
    };

    // Tap the audio path the same way (chained, so local sound is unaffected).
    if (this.audioEnabled && this.audioBridge) {
      this._packetizer = new AudioPacketizer({
        onPacket: (mono) => this._sendAudio(mono),
      });
      this._prevOnPcm = this.audioBridge.onPcm;
      this.audioBridge.onPcm = (buffer, rate) => {
        if (this._readyPeers().length) {
          try {
            this._packetizer.push(downmix(buffer, rate));
          } catch { /* a malformed chunk must never break local audio */ }
        }
        if (this._prevOnPcm) this._prevOnPcm(buffer, rate);
      };
    }

    this.log(`[remote] hosting as ${this.code}`);
    return { code: this.code, hostName: this.con.myHostName, url: this.con.webUrl };
  }

  _attach(peer) {
    this.peers.add(peer);
    // A peer object exists as soon as signaling starts, but sending before
    // the data channel opens throws — wait for dcOpen before streaming to it.
    peer._rdReady = !!peer.packAndSend;
    peer.rtcEvents?.on?.('dcOpen', () => {
      peer._rdReady = true;
      this.last = null; // fresh keyframe now that the guest can actually receive
      this.log(`[remote] guest ready (${this.peers.size} total)`);
    });
    this.log(`[remote] guest connecting (${this.peers.size} total)`);
    this.last = null; // force a keyframe for the newcomer

    peer.rtcEvents?.on?.('jsonMsg', (msg) => {
      if (msg?.topic === 'i' && Array.isArray(msg.pad)) {
        // A remote controller is just another controller.
        this.inputManager?.setRemoteInput?.(this.guestPort, unpackPad(msg.pad));
      } else if (msg?.topic === 'bye') {
        this._detach(peer);
      }
    });
    const drop = () => this._detach(peer);
    peer.rtcEvents?.on?.('closed', drop);
    peer.rtcEvents?.on?.('disconnected', drop);
  }

  _sendAudio(mono) {
    // Each packet carries its own ADPCM start state, so a lost packet costs
    // one click rather than desyncing the decoder for the rest of the session.
    const pkt = encodeChunk(mono, this._adpcm ?? { predictor: 0, index: 0 });
    this._adpcm = pkt.next;
    this.audioBytes += pkt.b.length;
    for (const peer of this._readyPeers()) {
      try {
        peer.sendJSONMsg?.({ topic: 'a', rate: REMOTE_RATE, b: pkt.b, n: pkt.n, p: pkt.p, x: pkt.x });
      } catch {
        // Audio is expendable: a dropped packet is a click, not a disconnect.
      }
    }
  }

  /** Peers whose data channel is actually open. */
  _readyPeers() {
    return [...this.peers].filter((p) => p._rdReady || p.packAndSend);
  }

  _detach(peer) {
    if (!this.peers.delete(peer)) return;
    this.log(`[remote] guest disconnected (${this.peers.size} left)`);
    // P2 leaving must never disturb P1: drop the remote controller and the
    // game just sees that port go idle.
    if (!this.peers.size) this.inputManager?.setRemoteInput?.(this.guestPort, null);
  }

  _onFrame(rgba, width, height) {
    if (!this._readyPeers().length) return;
    const now = Date.now();
    if (now - this.lastSent < this.minInterval) return;
    this.lastSent = now;

    const stride = width * 4;
    const cur = Buffer.from(rgba.buffer ?? rgba, rgba.byteOffset ?? 0, stride * height);
    const keyframe = !this.last || this.last.length !== cur.length || this.frameNo % KEYFRAME_EVERY === 0;

    let y0 = 0;
    let y1 = height;
    if (!keyframe) {
      // Find the changed row band — most retro frames only move part of the screen.
      y0 = height;
      y1 = 0;
      for (let y = 0; y < height; y++) {
        const off = y * stride;
        if (cur.compare(this.last, off, off + stride, off, off + stride) !== 0) {
          if (y < y0) y0 = y;
          if (y >= y1) y1 = y + 1;
        }
      }
      if (y0 >= y1) { this.frameNo++; return; } // nothing moved
    }

    const slice = cur.subarray(y0 * stride, y1 * stride);
    const b64 = deflateSync(slice, { level: 1 }).toString('base64'); // speed over ratio
    const total = Math.ceil(b64.length / CHUNK_CHARS) || 1;
    const id = this.frameNo;
    this.bytesSent += b64.length;

    for (const peer of this._readyPeers()) {
      try {
        for (let i = 0; i < total; i++) {
          peer.sendJSONMsg?.({
            topic: 'v',
            id,
            i,
            n: total,
            w: width,
            h: height,
            y: y0,
            key: keyframe,
            b: b64.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS),
          });
        }
      } catch (err) {
        // A failed send is a hiccup, not a departure — only the channel's own
        // closed/disconnected events remove a guest.
        this.log(`[remote] send failed: ${err.message}`);
      }
    }
    this.last = Buffer.from(cur);
    this.frameNo++;
  }

  status() {
    return {
      hosting: !!this.con,
      code: this.code,
      guests: this.peers.size,
      framesSent: this.frameNo,
      kbSent: Math.round(this.bytesSent / 1024),
      audio: this.audioEnabled && !!this.audioBridge,
      audioKbSent: Math.round(this.audioBytes / 1024),
    };
  }

  async stop() {
    if (this._prevOnFrame !== null) this.videoOutput.onFrameCallback = this._prevOnFrame;
    if (this.audioBridge && this._packetizer) this.audioBridge.onPcm = this._prevOnPcm;
    for (const peer of this.peers) {
      try { peer.sendJSONMsg?.({ topic: 'bye' }); } catch { /* going away anyway */ }
    }
    this.peers.clear();
    this.inputManager?.setRemoteInput?.(this.guestPort, null);
    try { await this.con?.end?.(); } catch { /* best effort */ }
    this.con = null;
    this.code = null;
  }
}

// ── guest ────────────────────────────────────────────────────────────
export class RemoteGuest {
  constructor({ onFrame, onAudio = null, getPad, watchOnly = false, log = () => {} }) {
    this.onFrame = onFrame; // (rgba, w, h) => void
    this.onAudio = onAudio; // (stereoBuffer, dstRate) => void
    this.audioPackets = 0;
    this.getPad = getPad; // () => gamepad-like | null
    this.watchOnly = watchOnly;
    this.log = log;
    this.con = null;
    this.peer = null;
    this.canvas = null;
    this.width = 0;
    this.height = 0;
    this.inputTimer = null;
    this.framesReceived = 0;
  }

  async join(code) {
    const { dynamicConnect } = await import('hsync');
    const hostName = parseCode(code);
    this.con = await dynamicConnect();
    this.peer = this.con.getRPCPeer({ hostName });

    this.peer.rtcEvents.on('jsonMsg', (msg) => this._onMessage(msg));
    await this.peer.connectRTC();
    this.log(`[remote] joined ${formatCode(hostName)}${this.watchOnly ? ' (spectator)' : ''}`);

    if (!this.watchOnly) {
      // 60Hz input — the doc's ~420 bytes/sec upstream.
      this.inputTimer = setInterval(() => {
        const pad = this.getPad?.();
        if (!pad) return;
        try {
          this.peer.sendJSONMsg({ topic: 'i', pad: Array.from(packPad(pad)) });
        } catch { /* channel hiccup; next tick retries */ }
      }, 16);
    }
    return { hostName, code: formatCode(hostName) };
  }

  _onMessage(msg) {
    if (msg?.topic === 'bye') return this.stop();
    if (msg?.topic === 'a') {
      if (!this.onAudio || !msg.b) return;
      try {
        this.audioPackets++;
        this.onAudio(decodeChunk(msg.n !== undefined ? msg : msg.b));
      } catch { /* a bad audio packet is a click, nothing more */ }
      return;
    }
    if (msg?.topic !== 'v' || msg.b === undefined) return;

    // Reassemble the chunked frame; a frame that arrives incomplete (peer
    // hiccup) is simply dropped — the next keyframe repairs the picture.
    if (!this._pending || this._pending.id !== msg.id) {
      this._pending = { id: msg.id, parts: new Array(msg.n).fill(null), have: 0 };
    }
    const p = this._pending;
    if (p.parts[msg.i] === null) {
      p.parts[msg.i] = msg.b;
      p.have++;
    }
    if (p.have < msg.n) return;
    this._pending = null;

    const stride = msg.w * 4;
    if (!this.canvas || this.width !== msg.w || this.height !== msg.h) {
      this.canvas = Buffer.alloc(stride * msg.h);
      this.width = msg.w;
      this.height = msg.h;
    }
    let slice;
    try {
      slice = inflateSync(Buffer.from(p.parts.join(''), 'base64'));
    } catch {
      return; // corrupt frame: skip, the next keyframe repairs it
    }
    slice.copy(this.canvas, msg.y * stride);
    this.framesReceived++;
    this.onFrame?.(this.canvas, msg.w, msg.h);
  }

  status() {
    return {
      joined: !!this.peer,
      framesReceived: this.framesReceived,
      audioPackets: this.audioPackets,
      watchOnly: this.watchOnly,
    };
  }

  async stop() {
    clearInterval(this.inputTimer);
    this.inputTimer = null;
    try { this.peer?.sendJSONMsg?.({ topic: 'bye' }); } catch { /* already gone */ }
    try { await this.con?.end?.(); } catch { /* best effort */ }
    this.peer = null;
    this.con = null;
  }
}
