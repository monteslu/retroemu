#!/usr/bin/env node
// retroemu --join <CODE> / --watch <CODE>
//
// The guest half of remote play: opens an SDL window, renders the host's
// streamed framebuffer, and sends this machine's controller back at 60Hz.
// No emulator runs here — the host is doing all the emulating.
import { VideoOutput } from '../src/video/VideoOutput.js';
import { AudioBridge } from '../src/audio/AudioBridge.js';
import { RemoteGuest, formatCode } from '../src/net/RemotePlay.js';
import { upmix } from '../src/net/audio.js';

export async function runJoin(code, { watchOnly = false, scale = 3 } = {}) {
  const videoOutput = new VideoOutput({
    video: 'sdl',
    scale,
    accelerated: true,
    initWidth: 320,
    initHeight: 240,
  });
  await videoOutput.init();

  // Playback for the host's streamed audio (its own device, no core here).
  const audioBridge = new AudioBridge();
  let audioReady = false;
  try {
    await audioBridge.init(48000);
    audioReady = true;
  } catch (err) {
    console.error('Audio unavailable — video only:', err.message);
  }

  let manager = null;
  if (!watchOnly) {
    try {
      const { installNavigatorShim } = await import('gamepad-node');
      manager = installNavigatorShim({ sdl: videoOutput.getSDL() });
    } catch {
      console.error('No gamepad support — joining as spectator.');
      watchOnly = true;
    }
  }

  let sized = false;
  const guest = new RemoteGuest({
    watchOnly,
    log: (m) => console.log(m),
    onAudio: (mono) => {
      if (audioReady) audioBridge.enqueuePcm(upmix(mono, audioBridge.sampleRate));
    },
    onFrame: (rgba, w, h) => {
      if (!sized) {
        sized = true;
        videoOutput.setAspectRatio(w / h);
        videoOutput.resizeWindow(w * scale, h * scale);
      }
      videoOutput.onCartFrameRGBA(rgba, w, h);
    },
    getPad: () => {
      if (!manager) return null;
      const pads = manager.getGamepads().filter(Boolean);
      return pads[0] ?? null;
    },
  });

  console.log(`Connecting to ${formatCode(code)}…`);
  await guest.join(code);
  console.log('Connected. Close the window or press Ctrl-C to leave.');

  const shutdown = async () => {
    await guest.stop();
    try { audioBridge.destroy(); } catch { /* already gone */ }
    try { videoOutput.destroy(); } catch { /* already gone */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const win = videoOutput.getSDLWindow();
  win?.on?.('close', shutdown);

  // Report throughput once a second so the human can see it's alive.
  setInterval(() => {
    const s = guest.status();
    if (s.framesReceived) {
      process.stdout.write(
        `\r  ${s.framesReceived} frames, ${s.audioPackets} audio packets received` +
        `${watchOnly ? ' (spectating)' : ''}   `);
    }
  }, 1000).unref?.();

  return guest;
}
