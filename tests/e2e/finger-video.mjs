// Writes a fake fingertip video for the browser tests: a flashlit fingertip
// (a smooth red glow) whose brightness dips with each heartbeat, as Chrome's
// fake camera needs a .y4m file. Beats are ~60 bpm with realistic
// beat-to-beat variation, so a reading comes out "good" with a plausible HRV.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const W = 32, H = 24, FPS = 30, SECONDS = 100;

// Deterministic pseudo-random numbers, so every run sees the same video.
let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// One pulse: fast rise, slower fall, small dicrotic bump. `phase` is 0–1.
function pulse(phase) {
  const main = phase < 0.15 ? phase / 0.15 : Math.exp(-(phase - 0.15) * 5);
  const notch = 0.15 * Math.exp(-(((phase - 0.45) / 0.05) ** 2));
  return main + notch;
}

export function fingerVideo(path) {
  // Beat times, alternating long/short around 1 s plus jitter.
  const beats = [0];
  while (beats.at(-1) < SECONDS + 2) beats.push(beats.at(-1) + 1 + (beats.length % 2 ? 0.08 : -0.08) + (rand() - 0.5) * 0.06);

  const header = Buffer.from(`YUV4MPEG2 W${W} H${H} F${FPS}:1 Ip A1:1 C420jpeg\n`);
  const frameSize = W * H * 1.5;
  const frames = SECONDS * FPS;
  const out = Buffer.alloc(header.length + frames * (6 + frameSize));
  header.copy(out, 0);
  let pos = header.length;
  let beat = 0;
  for (let f = 0; f < frames; f++) {
    const t = f / FPS;
    while (beats[beat + 1] <= t) beat++;
    const phase = (t - beats[beat]) / (beats[beat + 1] - beats[beat]);
    // More blood (the pulse peak) absorbs more light: the frame gets darker.
    const k = 1 - 0.05 * pulse(phase) + (rand() - 0.5) * 0.004;
    const r = 210 * k, g = 28 * k, b = 18 * k;
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const u = 128 - 0.1687 * r - 0.3313 * g + 0.5 * b;
    const v = 128 + 0.5 * r - 0.4187 * g - 0.0813 * b;
    pos += out.write('FRAME\n', pos);
    out.fill(Math.round(y), pos, pos + W * H); pos += W * H;
    out.fill(Math.round(u), pos, pos + W * H / 4); pos += W * H / 4;
    out.fill(Math.round(v), pos, pos + W * H / 4); pos += W * H / 4;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, out);
}
