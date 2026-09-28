// One camera heart reading, independent of any particular screen: finds the
// lens under the fingertip, waits for a steady signal, records, analyses.
// Screens pass callbacks for whatever feedback they want to show.

import { analyzePPG, bandpass, dominantPeriod, findPeaks, fingerDetected } from './signal.js';
import { loadSettings, saveSettings } from './storage.js';

const SETTLE_MS = 3000; // let auto-exposure settle once the finger is on
const LOST_MS = 2500; // finger off the lens this long ends the reading

// Keep the screen on while measuring (not available everywhere).
async function keepAwake() {
  try { return await navigator.wakeLock?.request('screen'); } catch { return null; }
}

export function cameraMessage(info) {
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

  const finish = async (outcome) => {
    if (stopped) return;
    stopped = true;
    await cam.stop();
    wake?.release?.().catch?.(() => {});
    resolveDone(outcome);
  };

  (async () => {
    onMessage?.('Checking which lens your finger is covering…');
    wake = await keepAwake();
    let info;
    try {
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
    if (info.identified) saveSettings({ fingerCameraId: info.deviceId });
    onMessage?.(cameraMessage(info));

    const times = [], red = [], green = [];
    let fingerSince = null;
    let lastFinger = null;
    let startT = null;
    let lastUi = 0;

    cam.onSample = (s) => {
      if (stopped) return;
      const covered = fingerDetected(s);
      if (covered) { lastFinger = s.t; fingerSince ??= s.t; } else if (startT === null) fingerSince = null;

      if (startT === null) {
        if (covered && s.t - fingerSince >= SETTLE_MS) startT = s.t;
      } else {
        if (s.t - lastFinger > LOST_MS) {
          finish({ ok: false, reason: 'Your finger moved off the lens. Rest your arm on your lap or a table to keep the phone steady, and try again.' });
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
          if (!r.ok) finish({ ok: false, reason: r.reason });
          else if (r.quality === 'poor') finish({ ok: false, poor: true, hrv, reason: 'The signal was weak, so this reading may not be reliable.' });
          else finish({ ok: true, hrv });
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
