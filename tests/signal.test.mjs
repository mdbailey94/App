import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzePPG, analyzeChannel, bandpass, classifyIntervals, dominantPeriod,
  fingerDetected, hrvMetrics, liveHeartRate, resample,
} from '../src/signal.js';

// Deterministic PRNG so tests are reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// Build a camera-like brightness trace from a list of beat intervals (ms).
// Each beat is a sharp dip in brightness (blood volume up) that recovers
// slowly, sampled at an irregular ~30 fps with drift and sensor noise.
function syntheticPPG(ibis, { fps = 30, noise = 0.3, jitterMs = 4, seed = 1 } = {}) {
  const rand = rng(seed);
  const beats = [500];
  for (const ibi of ibis) beats.push(beats[beats.length - 1] + ibi);
  const end = beats[beats.length - 1] + 500;
  const times = [];
  const red = [];
  for (let t = 0; t < end; t += 1000 / fps + (rand() - 0.5) * 2 * jitterMs) {
    let pulse = 0;
    for (const b of beats) {
      const dt = (t - b) / 1000;
      if (dt < -0.15 || dt > 0.9) continue;
      // Gaussian systolic wave + small dicrotic wave.
      pulse += Math.exp(-((dt - 0.0) ** 2) / (2 * 0.06 ** 2));
      pulse += 0.25 * Math.exp(-((dt - 0.3) ** 2) / (2 * 0.05 ** 2));
    }
    const drift = 5 * Math.sin((2 * Math.PI * t) / 20000) + t / 10000;
    red.push(200 + drift - 3 * pulse + noise * (rand() - 0.5) * 2);
    times.push(t);
  }
  return { times, red, beats };
}

function rmssdOf(ibis) {
  let s = 0;
  for (let i = 1; i < ibis.length; i++) s += (ibis[i] - ibis[i - 1]) ** 2;
  return Math.sqrt(s / (ibis.length - 1));
}

test('resample produces a uniform grid with interpolated values', () => {
  const { values } = resample([0, 100, 300], [0, 10, 30], 10);
  assert.deepEqual(Array.from(values), [0, 10, 20, 30]);
});

test('bandpass removes DC and slow drift but keeps the pulse band', () => {
  const fs = 50;
  const x = Array.from({ length: fs * 20 }, (_, i) => 100 + i * 0.05 + Math.sin((2 * Math.PI * 1.2 * i) / fs));
  const y = bandpass(x, fs);
  const mid = y.slice(fs * 3, fs * 17);
  const peak = Math.max(...mid.map(Math.abs));
  assert.ok(peak > 0.8 && peak < 1.2, `pulse amplitude preserved, got ${peak}`);
  const avg = mid.reduce((a, b) => a + b, 0) / mid.length;
  assert.ok(Math.abs(avg) < 0.05, `DC removed, got ${avg}`);
});

test('dominantPeriod finds the rate of a clean sine', () => {
  const fs = 50;
  const x = Array.from({ length: fs * 20 }, (_, i) => Math.sin((2 * Math.PI * 1.25 * i) / fs));
  const { bpm, periodicity } = dominantPeriod(x, fs);
  assert.ok(Math.abs(bpm - 75) < 1, `bpm ${bpm}`);
  assert.ok(periodicity > 0.9);
});

test('recovers heart rate and RMSSD from a synthetic recording with HRV', () => {
  const rand = rng(7);
  // ~60 bpm with respiratory sinus arrhythmia plus beat-to-beat noise.
  const ibis = [];
  for (let i = 0; i < 70; i++) {
    ibis.push(1000 + 60 * Math.sin((2 * Math.PI * i) / 5) + (rand() - 0.5) * 40);
  }
  const { times, red } = syntheticPPG(ibis, { seed: 3 });
  const r = analyzePPG(times, { red });
  assert.equal(r.ok, true, r.reason);
  const trueHr = 60000 / (ibis.reduce((a, b) => a + b, 0) / ibis.length);
  const trueRmssd = rmssdOf(ibis);
  assert.ok(Math.abs(r.hr - trueHr) < 1.5, `hr ${r.hr} vs ${trueHr}`);
  assert.ok(Math.abs(r.rmssd - trueRmssd) / trueRmssd < 0.15, `rmssd ${r.rmssd} vs ${trueRmssd}`);
  assert.equal(r.quality, 'good');
  assert.ok(Math.abs(r.beats - (ibis.length + 1)) <= 2, `beats ${r.beats}`);
});

test('handles a fast heart rate without double counting', () => {
  const ibis = Array.from({ length: 150 }, (_, i) => 400 + 10 * Math.sin(i));
  const { times, red } = syntheticPPG(ibis, { seed: 11 });
  const r = analyzeChannel(times, red);
  assert.equal(r.ok, true, r.reason);
  assert.ok(Math.abs(r.hr - 150) < 3, `hr ${r.hr}`);
});

test('pure noise is rejected or rated poor', () => {
  const rand = rng(5);
  const times = [];
  const red = [];
  for (let t = 0; t < 60000; t += 33) { times.push(t); red.push(200 + (rand() - 0.5) * 6); }
  const r = analyzeChannel(times, red);
  assert.ok(!r.ok || r.quality === 'poor', `quality ${r.quality}`);
});

test('too-short recordings are refused', () => {
  const { times, red } = syntheticPPG([1000, 1000, 1000]);
  const r = analyzeChannel(times, red);
  assert.equal(r.ok, false);
});

test('classifyIntervals flags missed beats and implausible values', () => {
  const ibis = [1000, 990, 1010, 2000, 1000, 1005, 250, 995];
  assert.deepEqual(classifyIntervals(ibis), [true, true, true, false, true, true, false, true]);
});

test('hrvMetrics only uses successive pairs of valid intervals', () => {
  const ibis = [1000, 1020, 2000, 1000, 980];
  const valid = [true, true, false, true, true];
  const m = hrvMetrics(ibis, valid);
  assert.equal(Math.round(m.rmssd), 20);
  assert.equal(Math.round(m.hr), 60);
  assert.equal(m.pnn50, 0);
});

test('liveHeartRate returns a rate once enough signal is buffered', () => {
  const ibis = Array.from({ length: 12 }, () => 800);
  const { times, red } = syntheticPPG(ibis);
  const bpm = liveHeartRate(times, red);
  assert.ok(bpm && Math.abs(bpm - 75) <= 3, `bpm ${bpm}`);
  assert.equal(liveHeartRate(times.slice(0, 50), red.slice(0, 50)), null);
});

test('fingerDetected recognises a red, lit fingertip', () => {
  assert.equal(fingerDetected({ r: 230, g: 40, b: 30 }), true);
  assert.equal(fingerDetected({ r: 120, g: 115, b: 110 }), false);
  assert.equal(fingerDetected({ r: 20, g: 5, b: 5 }), false);
});
