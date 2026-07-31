import { performance } from 'node:perf_hooks';
import { ActiveBezelCompositor } from '../src/active-bezel/Compositor.js';
import { ActiveBezelGpuCompositor } from '../src/active-bezel/GpuCompositor.js';

const game = new Uint8Array(256 * 240 * 4);
for (let i = 0; i < game.length; i += 4) {
  game[i] = (i >>> 2) & 255;
  game[i + 1] = 96;
  game[i + 2] = 192;
  game[i + 3] = 255;
}

function submit(compositor, frame) {
  compositor.reset();
  compositor.clear(0x101520ff);
  compositor.drawGame(320, 0, 1280, 1080);
  for (let i = 0; i < 24; i++) {
    compositor.fillRect(30 + (i % 4) * 70, 80 + Math.floor(i / 4) * 120,
      54, 90, i === frame % 24 ? 0xe5c07bff : 0x29334aff);
  }
  compositor.triangle(1640, 100, 1850, 540, 1640, 980, 0x73c9b0c0);
}

function run(label, compositor, frames) {
  for (let i = 0; i < 5; i++) {
    submit(compositor, i);
    compositor.compose(game, 256, 240);
  }
  const started = performance.now();
  for (let i = 0; i < frames; i++) {
    submit(compositor, i);
    compositor.compose(game, 256, 240);
  }
  const elapsed = performance.now() - started;
  return { label, frames, totalMs: elapsed, averageMs: elapsed / frames };
}

const results = [];
for (const [width, height, frames] of [[640, 360, 120], [1920, 1080, 30]]) {
  const cpu = new ActiveBezelCompositor({ outputWidth: width, outputHeight: height });
  results.push(run(`cpu-${width}x${height}`, cpu, frames));
  const gpu = ActiveBezelGpuCompositor.create({ outputWidth: width, outputHeight: height });
  if (gpu) {
    results.push(run(`gpu-${width}x${height}-including-readback`, gpu, frames));
    gpu.destroy();
  }
}
console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  note: 'GPU numbers include synchronous final-composite readback for screenshots/remote consumers.',
  results,
}, null, 2));
