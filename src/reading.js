// One camera heart reading, independent of any particular screen: finds the
// lens under the fingertip, waits for a steady signal, records, analyses.
// Screens pass callbacks for whatever feedback they want to show.

import { analyzePPG, bandpass, dominantPeriod, findPeaks, fingerDetected } from './signal.js';
import { loadSettings, saveSettings } from './storage.js';
import { listCameras } from './camera.js';

const SETTLE_MS = 3000; // let auto-exposure settle once the finger is on
const LOST_MS = 2500; // finger off the lens this long ends the reading
const NO_FINGER_MS = 30000; // give up if no fingertip is seen for this long

// Keep the screen on while measuring (not available everywhere).
async function keepAwake() {
  try { return await navigator.wakeLock?.request('screen'); } catch { return null; }
}

function cameraMessage(info) {
  if (info.front) return 'Using the front camera, lit by your screen. Keep your screen brightness all the way up.';
  const name = info.label ? ` (${info.label})` : '';
  const using = info.identified
    ? `Using the lens under your finger${name}. `
    : `Couldn’t tell which lens your finger is on, so using ${info.label || 'the camera next to the flash'}. If the preview shows the room, stop, cover both the flashlight and the camera closest to it, and try again in a lit room. `;
  return info.torch
    ? using
    : `${using}The flashlight can’t be switched on for this lens in this browser (iPhone browsers never allow it), so measure next to a bright lamp or window.`;
}

/**
 * Start a reading. Callbacks (all optional):
 *   onMessage(text)                   – status text (lens search, camera used)
 *   onFinger(state)                   – 'none' | 'settling' | 'recording' | 'lost'
 *   onProgress(fraction, secondsLeft) – while recording
 *   onWave(values, peaks)             – trailing filtered pulse for drawing
 * Returns { done, stop }. `done` resolves to { ok: true, hrv } or
 * { ok: false, reason, poor?, hrv? } (poor = measured but weak signal).
 */
export function startReading(cam, { durationSec = 60, posture = 'lying', onMessage, onFinger, onProgress, onWave } = {}) {
  let stopped = false;
  let wake = null;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });

  let diag = { started: new Date().toISOString(), ua: navigator.userAgent, durationSec };
  const finish = async (outcome) => {
    if (stopped) return;
    stopped = true;
    outcome.diag = { ...diag, ...(outcome.analysis || {}), reason: outcome.reason || null };
    delete outcome.analysis;
    await cam.stop();
    wake?.release?.().catch?.(() => {});
    resolveDone(outcome);
  };

  (async () => {
    onMessage?.('Checking which lens your finger is covering…');
    wake = await keepAwake();
    let info;
    try {
      if (cam.front) onMessage?.('Starting the front camera…');
      info = await cam.start(loadSettings().fingerCameraId, (n, total) => {
        onMessage?.(`Checking which lens your finger is covering… (lens ${n}${total ? ` of ${total}` : ''})`);
      });
    } catch (err) {
      finish({
        ok: false,
        reason: err.name === 'NotAllowedError'
          ? 'Camera permission was denied. Allow camera access in your browser settings and try again.'
          : `Couldn’t start the camera: ${err.message}`,
      });
      return;
    }
    if (stopped) { cam.stop(); return; }
    if (info.identified && !info.front) saveSettings({ fingerCameraId: info.deviceId });
    onMessage?.(cameraMessage(info));
    const cameras = await listCameras().catch(() => []);
    diag = { ...diag, lensFound: info.identified, cameras: cameras.map((c) => c.label || '?'), camera: cam.describe?.() };
    const summary = () => {
      const n = seen.frames || 1;
      const secs = seen.lastT !== null && seen.lastT > seen.firstT ? (seen.lastT - seen.firstT) / 1000 : 0;
      return {
        camera: cam.describe?.(), frames: seen.frames, fps: secs ? +(seen.frames / secs).toFixed(1) : null,
        fingerOnPct: Math.round((seen.covered / n) * 100), redClippedPct: Math.round((seen.saturated / n) * 100),
        meanRGB: [seen.r, seen.g, seen.b].map((v) => Math.round(v / n)), meanTexture: +(seen.texture / n).toFixed(1),
      };
    };

    const times = [], red = [], green = [];
    let fingerSince = null;
    let lastFinger = null;
    let startT = null;
    let lastUi = 0;
    let prevT = -Infinity;
    // Running totals for the diagnostics report.
    const seen = { frames: 0, covered: 0, saturated: 0, r: 0, g: 0, b: 0, texture: 0, firstT: null, lastT: null };

    cam.onSample = (s) => {
      if (stopped) return;
      if (s.t <= prevT) { // the camera changed clock: start the wait again
        fingerSince = null; lastFinger = null; startT = null;
        times.length = 0; red.length = 0; green.length = 0;
      }
      prevT = s.t;
      const covered = fingerDetected(s);
      seen.frames++; seen.firstT ??= s.t; seen.lastT = s.t;
      seen.r += s.r; seen.g += s.g; seen.b += s.b; seen.texture += s.texture || 0;
      if (covered) seen.covered++;
      if (s.r >= 250) seen.saturated++;
      if (covered) { lastFinger = s.t; fingerSince ??= s.t; } else if (startT === null) fingerSince = null;

      if (startT === null) {
        if (covered && s.t - fingerSince >= SETTLE_MS) startT = s.t;
        else if (!covered && s.t - seen.firstT > NO_FINGER_MS) {
          finish({ ok: false, noFinger: true, analysis: summary(), reason: 'The app couldn’t see a fingertip on the camera. Cover both the flashlight and the camera closest to it, pressing lightly, and try again.' });
          return;
        }
      } else {
        if (s.t - lastFinger > LOST_MS) {
          finish({ ok: false, analysis: summary(), reason: 'Your finger moved off the lens. Rest your arm on your lap or a table to keep the phone steady, and try again.' });
          return;
        }
        times.push(s.t); red.push(s.r); green.push(s.g);
        if (s.t - startT >= durationSec * 1000) {
          const r = analyzePPG(times, { red, green });
          const hrv = r.ok ? {
            hr: r.hr, rmssd: r.rmssd, lnRmssd: r.lnRmssd, sdnn: r.sdnn, pnn50: r.pnn50,
            beats: r.beats, validFraction: r.validFraction, quality: r.quality, channel: r.channel,
            durationSec, posture, source: 'camera', measuredAt: new Date().toISOString(),
          } : null;
          const analysis = { ...summary(), quality: r.quality, channel: r.channel, validFraction: r.validFraction, hr: r.hr, beats: r.beats };
          if (!r.ok) finish({ ok: false, analysis, reason: r.reason });
          else if (r.quality === 'poor') finish({ ok: false, poor: true, hrv, analysis, reason: 'The signal was weak, so this reading may not be reliable.' });
          else finish({ ok: true, hrv, analysis });
          return;
        }
      }

      const now = performance.now();
      if (now - lastUi < 100) return;
      lastUi = now;
      if (startT === null) {
        onFinger?.(covered ? 'settling' : 'none');
        onProgress?.(0, durationSec);
        return;
      }
      onFinger?.(covered ? 'recording' : 'lost');
      const elapsed = (s.t - startT) / 1000;
      onProgress?.(Math.min(1, elapsed / durationSec), Math.max(0, Math.ceil(durationSec - elapsed)));
      if (onWave && red.length > 30) {
        const from = times.findIndex((x) => x >= s.t - 6000);
        const wave = bandpass(red.slice(from).map((v) => -v), 30).slice(-150);
        const { periodSamples } = dominantPeriod(wave, 30);
        onWave(wave, findPeaks(wave, 30, periodSamples));
      }
    };
  })();

  return { done, stop: () => finish({ ok: false, cancelled: true, reason: 'Stopped.' }) };
}
