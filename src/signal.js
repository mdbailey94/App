// Photoplethysmography (PPG) signal processing.
//
// The camera sees a fingertip lit by the flashlight. Each heartbeat pushes a
// small pulse of blood into the fingertip, which absorbs more light, so the
// average frame brightness dips once per beat. This module turns that raw
// brightness series into beat times, heart rate and HRV metrics.
//
// Everything here is pure (no DOM) so it can be unit tested in Node.

export const DEFAULTS = {
  fs: 50, // Hz, uniform resampling rate
  minBpm: 40,
  maxBpm: 200,
  lowCutHz: 0.7,
  highCutHz: 3.5,
  // A beat interval deviating more than this fraction from the local median
  // is treated as an artifact (motion, missed or extra beat).
  artifactTolerance: 0.25,
};

// ---------------------------------------------------------------- utilities

export function mean(xs) {
  if (!xs.length) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function median(xs) {
  if (!xs.length) return NaN;
  const s = Array.from(xs).sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function std(xs) {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

// Linearly resample irregular (timeMs, value) samples onto a uniform grid.
export function resample(times, values, fs) {
  const n = times.length;
  if (n < 2) return { t0: times[0] ?? 0, values: new Float64Array(0) };
  const t0 = times[0];
  const step = 1000 / fs;
  const count = Math.floor((times[n - 1] - t0) / step) + 1;
  const out = new Float64Array(count);
  let j = 0;
  for (let i = 0; i < count; i++) {
    const t = t0 + i * step;
    while (j < n - 2 && times[j + 1] < t) j++;
    const ta = times[j];
    const tb = times[j + 1];
    const f = tb > ta ? (t - ta) / (tb - ta) : 0;
    out[i] = values[j] + (values[j + 1] - values[j]) * Math.min(1, Math.max(0, f));
  }
  return { t0, values: out };
}

// ------------------------------------------------------------------ filters

// Second-order Butterworth sections (RBJ audio EQ cookbook, Q = 1/sqrt(2)).
function biquad(type, cutoffHz, fs) {
  const w0 = (2 * Math.PI * cutoffHz) / fs;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  let b;
  if (type === 'lowpass') b = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
  else b = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
  return {
    b0: b[0] / a0, b1: b[1] / a0, b2: b[2] / a0,
    a1: (-2 * cos) / a0, a2: (1 - alpha) / a0,
  };
}

function applyBiquad(c, x) {
  const y = new Float64Array(x.length);
  let x1 = x[0], x2 = x[0], y1 = 0, y2 = 0;
  // Start from steady state for the first sample to reduce the transient.
  if (c.b0 + c.b1 + c.b2 !== 0) {
    const dc = x[0] * (c.b0 + c.b1 + c.b2) / (1 + c.a1 + c.a2);
    y1 = dc; y2 = dc;
  }
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = c.b0 * xi + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
    y[i] = yi;
  }
  return y;
}

// Zero-phase band-pass (forward + backward pass) so beat timing is not shifted.
export function bandpass(x, fs, lowHz = DEFAULTS.lowCutHz, highHz = DEFAULTS.highCutHz) {
  if (x.length < 4) return Float64Array.from(x);
  const m = mean(x);
  // Reflect-pad by up to 2 s on each side to tame edge transients.
  const pad = Math.min(x.length - 1, Math.round(fs * 2));
  const padded = new Float64Array(x.length + 2 * pad);
  for (let i = 0; i < pad; i++) {
    padded[i] = 2 * x[0] - x[pad - i] - m;
    padded[padded.length - 1 - i] = 2 * x[x.length - 1] - x[x.length - 1 - pad + i] - m;
  }
  for (let i = 0; i < x.length; i++) padded[pad + i] = x[i] - m;

  const hp = biquad('highpass', lowHz, fs);
  const lp = biquad('lowpass', highHz, fs);
  const pass = (s) => applyBiquad(lp, applyBiquad(hp, s));
  let y = pass(padded).reverse();
  y = pass(y).reverse();
  return y.slice(pad, pad + x.length);
}

// ---------------------------------------------------- rate & peak detection

// Dominant beat period via autocorrelation, searched within the physiological range.
export function dominantPeriod(x, fs, minBpm = DEFAULTS.minBpm, maxBpm = DEFAULTS.maxBpm) {
  const minLag = Math.max(1, Math.floor((60 / maxBpm) * fs));
  const maxLag = Math.min(x.length - 1, Math.ceil((60 / minBpm) * fs));
  let r0 = 0;
  for (let i = 0; i < x.length; i++) r0 += x[i] * x[i];
  if (r0 === 0 || maxLag <= minLag) return { periodSamples: NaN, bpm: NaN, periodicity: 0 };

  const acf = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1 && lag < x.length; lag++) {
    let s = 0;
    for (let i = 0; i + lag < x.length; i++) s += x[i] * x[i + lag];
    // Unbiased normalisation so long lags are not penalised.
    acf[lag] = (s / (x.length - lag)) / (r0 / x.length);
  }
  // Take the first strong local maximum rather than the global one, so a
  // harmonic at twice the period is not preferred.
  let best = -1;
  let bestVal = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (acf[lag] > bestVal) { bestVal = acf[lag]; best = lag; }
  }
  for (let lag = minLag; lag <= maxLag; lag++) {
    const isPeak = acf[lag] >= acf[lag - 1] && acf[lag] >= acf[lag + 1];
    if (isPeak && acf[lag] >= 0.8 * bestVal) { best = lag; bestVal = acf[lag]; break; }
  }
  // Parabolic interpolation for sub-sample precision.
  let period = best;
  const a = acf[best - 1], b = acf[best], c = acf[best + 1];
  const denom = a - 2 * b + c;
  if (best > minLag && best < maxLag && denom !== 0) period = best + (0.5 * (a - c)) / denom;
  return { periodSamples: period, bpm: (60 * fs) / period, periodicity: Math.max(0, bestVal) };
}

// Find systolic peaks; returns fractional sample indices.
export function findPeaks(x, fs, periodSamples) {
  const minDist = Number.isFinite(periodSamples)
    ? Math.max(1, Math.floor(0.6 * periodSamples))
    : Math.floor((60 / DEFAULTS.maxBpm) * fs);

  const candidates = [];
  for (let i = 1; i < x.length - 1; i++) {
    if (x[i] > 0 && x[i] > x[i - 1] && x[i] >= x[i + 1]) candidates.push(i);
  }
  // Greedy: keep the tallest peaks first, suppress neighbours within minDist.
  candidates.sort((i, j) => x[j] - x[i]);
  const taken = new Uint8Array(x.length);
  const kept = [];
  for (const i of candidates) {
    let clash = false;
    for (let k = Math.max(0, i - minDist + 1); k < Math.min(x.length, i + minDist); k++) {
      if (taken[k]) { clash = true; break; }
    }
    if (!clash) { taken[i] = 1; kept.push(i); }
  }
  kept.sort((a, b) => a - b);
  if (!kept.length) return [];

  // Drop peaks far smaller than their neighbours (dicrotic notch, noise).
  const heights = kept.map((i) => x[i]);
  const result = [];
  for (let k = 0; k < kept.length; k++) {
    const local = heights.slice(Math.max(0, k - 5), k + 6);
    if (heights[k] < 0.3 * median(local)) continue;
    const i = kept[k];
    const a = x[i - 1], b = x[i], c = x[i + 1];
    const denom = a - 2 * b + c;
    result.push(denom !== 0 ? i + (0.5 * (a - c)) / denom : i);
  }
  return result;
}

// -------------------------------------------------------------- HRV metrics

// Label each inter-beat interval (ms) as valid or an artifact.
export function classifyIntervals(ibis, opts = {}) {
  const { minBpm, maxBpm, artifactTolerance } = { ...DEFAULTS, ...opts };
  const lo = 60000 / maxBpm;
  const hi = 60000 / minBpm;
  const inRange = ibis.filter((v) => v >= lo && v <= hi);
  return ibis.map((v, i) => {
    if (v < lo || v > hi) return false;
    const window = ibis.slice(Math.max(0, i - 5), i + 6).filter((w) => w >= lo && w <= hi);
    const ref = window.length >= 3 ? median(window) : median(inRange);
    return Math.abs(v - ref) <= artifactTolerance * ref;
  });
}

export function hrvMetrics(ibis, valid) {
  const good = ibis.filter((_, i) => valid[i]);
  const diffs = [];
  for (let i = 1; i < ibis.length; i++) {
    if (valid[i] && valid[i - 1]) diffs.push(ibis[i] - ibis[i - 1]);
  }
  const rmssd = diffs.length >= 2
    ? Math.sqrt(diffs.reduce((s, d) => s + d * d, 0) / diffs.length)
    : NaN;
  const pnn50 = diffs.length ? (100 * diffs.filter((d) => Math.abs(d) > 50).length) / diffs.length : NaN;
  const meanIbi = mean(good);
  return {
    hr: 60000 / meanIbi,
    meanIbi,
    rmssd,
    lnRmssd: Math.log(rmssd),
    sdnn: std(good),
    pnn50,
  };
}

function qualityLabel({ validFraction, beats, periodicity, durationSec }) {
  const expectedMin = durationSec * (DEFAULTS.minBpm / 60) * 0.8;
  if (beats < Math.min(20, expectedMin)) return 'poor';
  if (validFraction >= 0.9 && periodicity >= 0.5) return 'good';
  if (validFraction >= 0.75 && periodicity >= 0.3) return 'fair';
  return 'poor';
}

// Full pipeline for one brightness channel.
export function analyzeChannel(times, values, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const durationSec = (times[times.length - 1] - times[0]) / 1000;
  if (!(durationSec >= 10)) {
    return { ok: false, reason: 'Recording too short (need at least 10 s).' };
  }
  const { t0, values: uniform } = resample(times, values, o.fs);
  // Brightness falls as blood volume rises, so invert: peaks = pulse peaks.
  const inverted = uniform.map((v) => -v);
  const filtered = bandpass(inverted, o.fs, o.lowCutHz, o.highCutHz);
  const { periodSamples, periodicity } = dominantPeriod(filtered, o.fs, o.minBpm, o.maxBpm);
  const peaks = findPeaks(filtered, o.fs, periodSamples);
  const peakTimes = peaks.map((p) => t0 + (p * 1000) / o.fs);
  const ibis = [];
  for (let i = 1; i < peakTimes.length; i++) ibis.push(peakTimes[i] - peakTimes[i - 1]);
  const valid = classifyIntervals(ibis, o);
  const validCount = valid.filter(Boolean).length;
  const validFraction = ibis.length ? validCount / ibis.length : 0;
  const metrics = hrvMetrics(ibis, valid);
  const beats = peaks.length;
  const quality = qualityLabel({ validFraction, beats, periodicity, durationSec });
  const ok = validCount >= 10 && Number.isFinite(metrics.rmssd);
  return {
    ok,
    reason: ok ? undefined : 'Could not find a clear, regular pulse. Keep still and cover the lens fully.',
    ...metrics,
    beats,
    validFraction,
    periodicity,
    quality,
    durationSec,
    peakTimes,
    ibis,
    valid,
    filtered,
    fs: o.fs,
    t0,
  };
}

const QUALITY_RANK = { good: 2, fair: 1, poor: 0 };

// Analyse every recorded colour channel and keep the one with the cleanest pulse.
// `channels` is { red: number[], green: number[], ... } aligned with `times`.
export function analyzePPG(times, channels, opts = {}) {
  let best = null;
  for (const [name, values] of Object.entries(channels)) {
    const r = analyzeChannel(times, values, opts);
    r.channel = name;
    const score = (r.ok ? 10 : 0) + (QUALITY_RANK[r.quality] ?? 0) * 2 + (r.validFraction || 0) + (r.periodicity || 0);
    if (!best || score > best.score) best = { score, r };
  }
  return best ? best.r : { ok: false, reason: 'No samples recorded.' };
}

// Cheap rate estimate for live feedback over a short trailing window.
export function liveHeartRate(times, values, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (times.length < 2 || times[times.length - 1] - times[0] < 4000) return null;
  const { values: uniform } = resample(times, values, o.fs);
  const filtered = bandpass(uniform.map((v) => -v), o.fs, o.lowCutHz, o.highCutHz);
  const { bpm, periodicity } = dominantPeriod(filtered, o.fs, o.minBpm, o.maxBpm);
  return periodicity >= 0.3 && Number.isFinite(bpm) ? Math.round(bpm) : null;
}

// Heuristic: is a fingertip covering the lens? With the torch on the frame is
// bright, saturated red; uncovered frames look like a normal scene.
export function fingerDetected({ r, g, b }) {
  return r > 60 && r > 1.5 * g && r > 1.5 * b;
}
